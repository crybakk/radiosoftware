/** Smista i messaggi tra la regia (una sola) e i pannelli remoti (quanti si vuole). */
import type { FromPanel, FromStudio, RemoteState, ToPanel, ToStudio } from './protocol.ts'
import { can, type PublicUser } from './users.ts'

export interface Peer {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface Pending {
  panel: Peer
  panelId: string
  timer: ReturnType<typeof setTimeout>
}

const REPLY_TIMEOUT_MS = 10_000

export class Relay {
  private studio: Peer | null = null
  private state: RemoteState | null = null
  private panels = new Map<Peer, PublicUser>()
  private pending = new Map<string, Pending>()
  private seq = 0
  private token: string
  private alarms: ToPanel & { t: 'alarms' } = { t: 'alarms', alarms: [] }
  onStudioChange: (connected: boolean) => void = () => {}

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
        if (!authed) {
          if (msg.t !== 'auth' || msg.token !== this.token) {
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
          const p = this.pending.get(msg.id)
          if (!p) return
          clearTimeout(p.timer)
          this.pending.delete(msg.id)
          this.sendTo(p.panel, { t: 'reply', id: p.panelId, ok: msg.ok, data: msg.data, error: msg.error })
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
          this.sendTo(p.panel, { t: 'reply', id: p.panelId, ok: false, error: 'regia scollegata' })
          this.pending.delete(id)
        }
      }
    }
  }

  private sendStudio(m: ToStudio): void {
    this.studio?.send(JSON.stringify(m))
  }

  // ---------- pannelli ----------

  attachPanel(peer: Peer, user: PublicUser): { message: (raw: string) => void; close: () => void } {
    this.panels.set(peer, user)
    this.sendTo(peer, { t: 'hello', user, studio: this.studio !== null, state: this.state })
    this.sendTo(peer, this.alarms)
    return {
      message: (raw: string) => {
        let msg: FromPanel
        try {
          msg = JSON.parse(raw) as FromPanel
        } catch {
          return
        }
        if (msg.t !== 'cmd' || typeof msg.id !== 'string' || !msg.cmd) return
        const reply = (ok: boolean, error?: string): void => this.sendTo(peer, { t: 'reply', id: msg.id, ok, error })
        // la ricerca è una lettura: la può fare anche chi non comanda
        if (msg.cmd.type !== 'search' && !can(user.role, 'comandare')) return reply(false, 'il tuo ruolo non permette di comandare la regia')
        if (!this.studio) return reply(false, 'regia scollegata')
        const id = `c${++this.seq}`
        this.pending.set(id, {
          panel: peer,
          panelId: msg.id,
          timer: setTimeout(() => {
            this.pending.delete(id)
            reply(false, 'la regia non ha risposto')
          }, REPLY_TIMEOUT_MS)
        })
        this.sendStudio({ t: 'cmd', id, cmd: msg.cmd, by: user.name })
      },
      close: () => {
        this.panels.delete(peer)
        for (const [id, p] of this.pending) {
          if (p.panel !== peer) continue
          clearTimeout(p.timer)
          this.pending.delete(id)
        }
      }
    }
  }

  /** Chiude le connessioni di un utente (eliminato o con password cambiata). */
  kick(name: string): void {
    for (const [peer, u] of this.panels) if (u.name.toLowerCase() === name.toLowerCase()) peer.close(4003, 'sessione chiusa')
  }

  setAlarms(alarms: { key: string; since: string; message: string }[]): void {
    this.alarms = { t: 'alarms', alarms }
    this.broadcast(this.alarms)
  }

  private sendTo(peer: Peer, m: ToPanel): void {
    peer.send(JSON.stringify(m))
  }

  private broadcast(m: ToPanel): void {
    const data = JSON.stringify(m)
    for (const peer of this.panels.keys()) peer.send(data)
  }
}
