/** Smista i messaggi tra la regia (una sola) e i pannelli remoti (quanti si vuole). */
import type { AutoState, FromPanel, GuestInfo, FromStudio, MicStatus, RemoteCommand, RemoteState, ToPanel, ToStudio, VideoStatus } from './protocol.ts'
import { can, sameSecret, type PublicUser } from './users.ts'
import type { VoiceHub } from './voce.ts'
import type { AutonomousPlayer } from './autonoma.ts'
import type { Guests } from './ospiti.ts'
import type { VideoLive } from './video.ts'

export interface Peer {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface Pending {
  /** Pannello che aspetta la risposta (null = comando del server, per esempio dal bot Telegram). */
  panel: Peer | null
  timer: ReturnType<typeof setTimeout>
  search: boolean
  done: (ok: boolean, data?: unknown, error?: string) => void
}

const REPLY_TIMEOUT_MS = 10_000

/** Comandi su eventi e rotazioni, con il permesso che serve sul pannello. */
export const EVENT_COMMANDS: Record<string, 'vedere' | 'comandare' | 'utenti'> = {
  events: 'vedere',
  eventRun: 'comandare',
  rotationSet: 'comandare',
  eventSave: 'utenti',
  eventDelete: 'utenti',
  eventEnable: 'utenti',
  rotationRules: 'utenti',
  aiStatus: 'vedere',
  aiGenerate: 'utenti',
  aiCancel: 'utenti',
  aiPreview: 'utenti',
  aiApply: 'utenti'
}

/** Comandi in attesa di risposta dalla regia, al massimo, per ogni pannello. */
export const MAX_PENDING_PER_PANEL = 20
/** Dimensione massima di un comando per la regia (JSON). */
const MAX_CMD_BYTES = 16 * 1024

export class Relay {
  private studio: Peer | null = null
  private state: RemoteState | null = null
  private panels = new Map<Peer, PublicUser>()
  private pending = new Map<string, Pending>()
  private seq = 0
  private token: string
  private alarms: ToPanel & { t: 'alarms' } = { t: 'alarms', alarms: [] }
  private mic: ToPanel & { t: 'mic' } = { t: 'mic', mic: { user: null, onAir: false } }
  onStudioChange: (connected: boolean) => void = () => {}
  /** Microfono remoto (WebRTC); null se non attivo sul ponte. */
  voice: VoiceHub | null = null
  /** Diretta autonoma dal server; null se non attiva sul ponte. */
  auto: AutonomousPlayer | null = null
  private autoState: (ToPanel & { t: 'autonoma' }) | null = null
  /** Ospiti collegati con un link; null se il microfono remoto è spento. */
  guests: Guests | null = null
  private guestList: ToPanel & { t: 'ospiti' } = { t: 'ospiti', guests: [] }
  /** Dirette video verso YouTube e Facebook; null se non attive sul ponte. */
  video: VideoLive | null = null
  private videoState: (ToPanel & { t: 'video' }) | null = null

  constructor(token: string) {
    this.token = token
  }

  studioConnected(): boolean {
    return this.studio !== null
  }

  lastState(): RemoteState | null {
    return this.state
  }

  // ---------- regia ----------

  /** Nuova connessione della regia: diventa valida solo dopo il messaggio di autenticazione. */
  attachStudio(peer: Peer): { message: (raw: string) => void; close: () => void } {
    let authed = false
    const authTimer = setTimeout(() => {
      if (!authed) peer.close(4001, 'autenticazione mancante')
    }, 5000)
    return {
      message: (raw: string) => {
        let msg: FromStudio
        try {
          msg = JSON.parse(raw) as FromStudio
        } catch {
          return
        }
        // JSON valido ma non un oggetto (null, numeri, liste…): lo ignoriamo
        if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return
        if (!authed) {
          if (msg.t !== 'auth' || typeof msg.token !== 'string' || !sameSecret(msg.token, this.token)) {
            peer.close(4003, 'token non valido')
            return
          }
          authed = true
          clearTimeout(authTimer)
          // una sola regia: la nuova sostituisce la vecchia (per esempio dopo un cambio di rete)
          const old = this.studio
          this.studio = peer
          if (old && old !== peer) old.close(4000, 'sostituita da una nuova connessione')
          this.sendStudio({ t: 'auth-ok' })
          this.broadcast({ t: 'studio', connected: true })
          this.onStudioChange(true)
          return
        }
        if (msg.t === 'state') {
          this.state = msg.state
          this.broadcast({ t: 'state', state: msg.state })
        } else if (msg.t === 'reply') {
          if (typeof msg.id !== 'string') return
          const p = this.pending.get(msg.id)
          if (!p) return
          clearTimeout(p.timer)
          this.pending.delete(msg.id)
          p.done(msg.ok === true, msg.data, msg.error)
        }
      },
      close: () => {
        clearTimeout(authTimer)
        if (this.studio !== peer) return
        this.studio = null
        this.broadcast({ t: 'studio', connected: false })
        this.onStudioChange(false)
        // i comandi in attesa non avranno risposta
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer)
          this.pending.delete(id)
          p.done(false, undefined, 'regia scollegata')
        }
      }
    }
  }

  private sendStudio(m: ToStudio): void {
    this.studio?.send(JSON.stringify(m))
  }

  /** Segnale di vita a livello di applicazione verso la regia collegata. */
  pingStudio(): void {
    this.sendStudio({ t: 'ping' })
  }

  /** Manda un comando alla regia e chiama `done` con la risposta (o con l'errore dopo 10 secondi). */
  private forward(cmd: RemoteCommand, by: string, panel: Peer | null, search: boolean, done: Pending['done']): void {
    const id = `c${++this.seq}`
    this.pending.set(id, {
      panel,
      search,
      done,
      timer: setTimeout(() => {
        this.pending.delete(id)
        done(false, undefined, 'la regia non ha risposto')
      }, REPLY_TIMEOUT_MS)
    })
    this.sendStudio({ t: 'cmd', id, cmd, by })
  }

  /** Comando alla regia dal server stesso (bot Telegram): niente pannello, la risposta arriva come promessa. */
  command(cmd: RemoteCommand, by: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.studio) return reject(new Error('regia scollegata dal ponte'))
      let mine = 0
      for (const p of this.pending.values()) if (p.panel === null) mine++
      if (mine >= MAX_PENDING_PER_PANEL) return reject(new Error('troppi comandi in attesa: riprova tra poco'))
      this.forward(cmd, by, null, false, (ok, data, error) => (ok ? resolve(data) : reject(new Error(error || 'errore della regia'))))
    })
  }

  // ---------- pannelli ----------

  /**
   * Nuovo pannello. `host` = nome con cui il browser ha aperto il pannello (serve al microfono).
   * `current` (facoltativo) restituisce l'utente aggiornato della sessione:
   * a ogni comando si ricontrolla il ruolo, e senza sessione valida la connessione si chiude.
   */
  attachPanel(
    peer: Peer,
    user: PublicUser,
    host?: string,
    current?: () => PublicUser | null
  ): { message: (raw: string) => void; close: () => void } {
    this.panels.set(peer, user)
    this.sendTo(peer, { t: 'hello', user, studio: this.studio !== null, state: this.state })
    this.sendTo(peer, this.alarms)
    this.sendTo(peer, this.mic)
    if (this.autoState) this.sendTo(peer, this.autoState)
    if (this.guests) this.sendTo(peer, this.guestList)
    if (this.videoState) this.sendTo(peer, this.videoState)
    return {
      message: (raw: string) => {
        let msg: FromPanel
        try {
          msg = JSON.parse(raw) as FromPanel
        } catch {
          return
        }
        if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return
        if (msg.t === 'rtc-close') return this.voice?.close(peer)
        if (typeof msg.id !== 'string') return
        const reply = (ok: boolean, error?: string, data?: unknown): void =>
          this.sendTo(peer, { t: 'reply', id: msg.id, ok, error, data })
        const now = current ? current() : user
        if (!now) return peer.close(4003, 'sessione chiusa')
        if (msg.t === 'rtc-offer' || msg.t === 'mic') {
          if (!can(now.role, 'comandare')) return reply(false, 'il tuo ruolo non permette di andare in onda')
          const voice = this.voice
          if (!voice) return reply(false, 'microfono remoto non attivo sul ponte')
          const done = msg.t === 'rtc-offer'
            ? voice.open(peer, now.name, String(msg.sdp), host).then((sdp) => reply(true, undefined, { sdp }))
            : voice.setMic(peer, msg.on === true).then(() => reply(true))
          done.catch((e: unknown) => reply(false, e instanceof Error ? e.message : String(e)))
          return
        }
        if (msg.t === 'guest') {
          const guests = this.guests
          if (!guests || typeof msg.cmd !== 'object' || msg.cmd === null) return reply(false, 'ospiti non attivi sul ponte')
          if (!can(now.role, 'comandare')) return reply(false, 'il tuo ruolo non permette di gestire gli ospiti')
          guests
            .command(msg.cmd, now.name)
            .then((data) => reply(true, undefined, data))
            .catch((e: unknown) => reply(false, e instanceof Error ? e.message : String(e)))
          return
        }
        if (msg.t === 'video') {
          const video = this.video
          if (!video || typeof msg.cmd !== 'object' || msg.cmd === null) return reply(false, 'dirette video non attive sul ponte')
          if (msg.cmd.type === 'config' && !can(now.role, 'utenti')) return reply(false, 'solo gli amministratori cambiano le chiavi delle dirette')
          if (!can(now.role, 'comandare')) return reply(false, 'il tuo ruolo non permette di comandare le dirette video')
          try {
            reply(true, undefined, video.run(msg.cmd, now.name))
          } catch (e) {
            reply(false, e instanceof Error ? e.message : String(e))
          }
          return
        }
        if (msg.t === 'auto') {
          const auto = this.auto
          if (!auto || typeof msg.cmd !== 'object' || msg.cmd === null) return reply(false, 'diretta autonoma non attiva sul ponte')
          if (msg.cmd.type !== 'search' && !can(now.role, 'comandare')) return reply(false, 'il tuo ruolo non permette di comandare la diretta autonoma')
          auto
            .run(msg.cmd, now.name)
            .then((data) => reply(true, undefined, data))
            .catch((e: unknown) => reply(false, e instanceof Error ? e.message : String(e)))
          return
        }
        if (msg.t !== 'cmd' || typeof msg.cmd !== 'object' || msg.cmd === null) return
        // la ricerca e l'elenco degli eventi sono letture: le può fare anche chi non comanda
        const need = msg.cmd.type === 'search' ? 'vedere' : (EVENT_COMMANDS[msg.cmd.type] ?? 'comandare')
        if (!can(now.role, need)) {
          return reply(false, need === 'utenti' ? 'solo gli amministratori possono modificare eventi e regole di rotazione' : 'il tuo ruolo non permette di comandare la regia')
        }
        if (!this.studio) return reply(false, 'regia scollegata')
        // limiti per non sommergere la regia in onda: una ricerca alla volta e pochi comandi in attesa per pannello
        const search = msg.cmd.type === 'search'
        let mine = 0
        for (const p of this.pending.values()) {
          if (p.panel !== peer) continue
          mine++
          if (search && p.search) return reply(false, 'una ricerca è già in corso: attendi il risultato')
        }
        if (mine >= MAX_PENDING_PER_PANEL) return reply(false, 'troppi comandi in attesa: attendi le risposte della regia')
        if (Buffer.byteLength(JSON.stringify(msg.cmd)) > MAX_CMD_BYTES) return reply(false, 'comando troppo grande')
        this.forward(msg.cmd, now.name, peer, search, (ok, data, error) => reply(ok, error, data))
      },
      close: () => {
        this.panels.delete(peer)
        this.voice?.close(peer)
        for (const [id, p] of this.pending) {
          if (p.panel !== peer) continue
          clearTimeout(p.timer)
          this.pending.delete(id)
        }
      }
    }
  }

  /**
   * Chiude le connessioni di un utente (eliminato o con password cambiata: 4003, il pannello torna all'accesso).
   * Con un altro codice (per esempio 4002 dopo un cambio di ruolo) il pannello si ricollega da solo.
   */
  kick(name: string, code = 4003, reason = 'sessione chiusa'): void {
    for (const [peer, u] of this.panels) if (u.name.toLowerCase() === name.toLowerCase()) peer.close(code, reason)
  }

  setAlarms(alarms: { key: string; since: string; message: string }[]): void {
    this.alarms = { t: 'alarms', alarms }
    this.broadcast(this.alarms)
  }

  setGuests(guests: GuestInfo[]): void {
    this.guestList = { t: 'ospiti', guests }
    this.broadcast(this.guestList)
  }

  setVideo(video: VideoStatus): void {
    this.videoState = { t: 'video', video }
    this.broadcast(this.videoState)
  }

  setAuto(state: AutoState): void {
    this.autoState = { t: 'autonoma', state }
    this.broadcast(this.autoState)
  }

  setMic(mic: MicStatus): void {
    this.mic = { t: 'mic', mic }
    this.broadcast(this.mic)
  }

  private sendTo(peer: Peer, m: ToPanel): void {
    peer.send(JSON.stringify(m))
  }

  private broadcast(m: ToPanel): void {
    const data = JSON.stringify(m)
    for (const peer of this.panels.keys()) peer.send(data)
  }
}
