/**
 * App "Radio Esterna" (Mac e Windows) per le dirette da fuori (scelte di cristian, 24/11/2026).
 *
 * App ⇄ (WebSocket in HTTPS, porta 443, utente del pannello) ⇄ controllo ⇄ (Icecast interno, Ogg/Opus) ⇄ Liquidsoap
 *   - l'app manda l'audio del suo mixer (pezzi WebM/Opus del MediaRecorder) come messaggi binari;
 *   - il controllo li passa a ffmpeg, che li rimette in Ogg senza ricodificarli e li manda all'ingresso
 *     interno di Liquidsoap (porta non pubblicata);
 *   - collegata non vuol dire in onda: chi è fuori prova i livelli e va in onda con IN ONDA (dissolvenza come
 *     le altre esterne); FUORI ONDA torna la regia (o la riserva). La regia non deve accettare.
 *   - titolo in onda: "Programma – riga libera" scritto nell'app; un brano riconosciuto lo sostituisce per la
 *     durata del brano, poi torna il titolo del programma.
 *   - una sola app alla volta. Se la rete cade mentre è in onda l'app si ricollega e resta in onda; se non torna
 *     entro un minuto si passa fuori onda, così alla prossima apertura non si va in onda senza volerlo.
 *   - ascolto: la regia e il pannello sentono l'app anche fuori onda; l'app sente il ritorno dello studio.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { EsternaStatus } from './protocol.ts'

export interface AppPeer {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface Proc {
  stdin: NodeJS.WritableStream | null
  on(ev: 'exit', cb: (code: number | null) => void): void
  on(ev: 'error', cb: (e: Error) => void): void
  kill(): void
}
type Spawn = (cmd: string, args: string[], opts: { stdio: ('ignore' | 'pipe')[] }) => Proc

/** Messaggi dall'app (testo JSON). L'audio arriva a parte, in binario. */
export type FromApp =
  | { t: 'hello'; versione?: string; inOnda?: boolean; programId?: string | null; testo?: string }
  | { t: 'onda'; on: boolean }
  | { t: 'meta'; programId?: string | null; testo?: string }

/** Messaggi verso l'app. */
export type ToApp =
  | { t: 'benvenuto'; user: string; ritorno: string; stazione: string }
  | { t: 'stato'; stato: EsternaStatus; regia: boolean }
  | { t: 'errore'; messaggio: string }

export interface AppEsternaDeps {
  /** POST all'HTTP interno di Liquidsoap; true se ha risposto ok. */
  lq: (path: string, body: unknown) => Promise<boolean>
  /** Indirizzo dell'ingresso interno, es. icecast://source:password@liquidsoap:9011/app (null = spento). */
  icecastUrl: string | null
  /** Titolo del programma dall'id (null se non esiste). */
  programTitle: (id: string) => string | null
  stationName: string
  /** L'esterna dell'app è davvero in onda (in onda + audio che arriva) o non più. */
  onAir: (on: boolean, user: string, titolo: string) => void
  /** Nuovo titolo in onda (per /api/nowplaying). */
  onTitle?: (titolo: string) => void
  /** Stato cambiato (pannelli e regia). */
  onChange?: (s: EsternaStatus) => void
  /** La regia dello studio è collegata (per l'app). */
  studioConnected?: () => boolean
  ffmpeg?: string
  spawn?: Spawn
  log?: (s: string) => void
  /** Attesa prima di passare fuori onda quando l'app sparisce mentre è in onda (ms). */
  offDelayMs?: number
  now?: () => number
}

/** Byte al massimo in attesa verso ffmpeg: oltre si scartano (ffmpeg bloccato). */
const MAX_PENDING_BYTES = 2 * 1024 * 1024
const MAX_TESTO = 200

export function ffmpegArgs(url: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', '+nobuffer+genpts',
    '-f', 'webm', '-i', 'pipe:0',
    // l'Opus del browser passa così com'è, senza ricodifica
    '-map', '0:a:0', '-c:a', 'copy',
    '-content_type', 'audio/ogg', '-f', 'ogg', url
  ]
}

/** Toglie a capo e caratteri di controllo e taglia la riga libera. */
export function pulisciTesto(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TESTO)
}

/** Titolo in onda: "Programma – riga libera", oppure uno solo dei due, oppure "In diretta". */
export function componiTitolo(programma: string | null, testo: string): string {
  if (programma && testo) return `${programma} – ${testo}`
  return programma || testo || 'In diretta'
}

interface Conn {
  peer: AppPeer
  user: string
  ritorno: string
  proc: Proc | null
  pending: number
}

export class AppEsterna {
  private readonly d: AppEsternaDeps
  private readonly spawn: Spawn
  private readonly log: (s: string) => void
  private readonly now: () => number
  private conn: Conn | null = null
  /** Ultimo utente collegato (resta durante una caduta della rete, per il ritorno in onda). */
  private user: string | null = null
  private inOnda = false
  /** Audio dell'app collegato all'ingresso di Liquidsoap. */
  private audio = false
  private effective = false
  private since: number | null = null
  private programId: string | null = null
  private testo = ''
  private ascolto = randomBytes(18).toString('base64url')
  private offTimer: ReturnType<typeof setTimeout> | null = null
  private songTimer: ReturnType<typeof setTimeout> | null = null
  private song: { artist: string; title: string } | null = null

  constructor(d: AppEsternaDeps) {
    this.d = d
    this.spawn = d.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts) as unknown as Proc)
    this.log = d.log ?? ((s) => console.log(`[radio esterna] ${s}`))
    this.now = d.now ?? (() => Date.now())
  }

  enabled(): boolean {
    return !!this.d.icecastUrl
  }

  titolo(): string {
    return componiTitolo(this.programId ? this.d.programTitle(this.programId) : null, this.testo)
  }

  status(): EsternaStatus {
    return {
      collegata: this.conn !== null,
      audio: this.audio,
      user: this.conn?.user ?? (this.inOnda ? this.user : null),
      inOnda: this.inOnda,
      inOndaDavvero: this.effective,
      titolo: this.titolo(),
      programId: this.programId,
      since: this.since ? new Date(this.since).toISOString() : null,
      ascolto: this.conn || this.inOnda ? this.ascolto : null
    }
  }

  /** Token per ascoltare l'app (regia e pannello). */
  validAscolto(t: string | null): boolean {
    return !!t && t === this.ascolto && (this.conn !== null || this.inOnda)
  }

  /** Token dell'app collegata per il ritorno dello studio. */
  validRitorno(t: string | null): boolean {
    return !!t && !!this.conn && t === this.conn.ritorno
  }

  /** Nuova connessione dell'app (utente del pannello già controllato, ruolo da conduttore in su). */
  attach(peer: AppPeer, user: string): { message: (data: Buffer, binary: boolean) => void; close: () => void } {
    if (!this.enabled()) {
      this.sendTo(peer, { t: 'errore', messaggio: 'Il server non ha ancora l\'ingresso per Radio Esterna: aggiornalo dal pannello.' })
      peer.close(4010, 'ingresso spento')
      return { message: () => {}, close: () => {} }
    }
    const old = this.conn
    if (old && old.user.toLowerCase() !== user.toLowerCase()) {
      this.sendTo(peer, { t: 'errore', messaggio: `Radio Esterna è già collegata da ${old.user}: può esserci una sola esterna alla volta.` })
      peer.close(4009, 'già collegata')
      return { message: () => {}, close: () => {} }
    }
    // stessa persona (rete cambiata, app riaperta): la nuova connessione prende il posto della vecchia
    if (old) {
      this.conn = null
      this.stopAudio(old)
      old.peer.close(4000, 'sostituita da una nuova connessione')
    }
    // un altro utente prende il posto di chi era in onda ed è sparito
    if (this.inOnda && this.user && this.user.toLowerCase() !== user.toLowerCase()) void this.setOnda(false)
    if (this.offTimer) clearTimeout(this.offTimer)
    this.offTimer = null
    if (!this.inOnda) this.ascolto = randomBytes(18).toString('base64url')
    const c: Conn = { peer, user, ritorno: randomBytes(18).toString('base64url'), proc: null, pending: 0 }
    this.conn = c
    this.user = user
    this.log(`${user} si è collegato`)
    this.sendTo(peer, { t: 'benvenuto', user, ritorno: c.ritorno, stazione: this.d.stationName })
    this.emit()
    return {
      message: (data, binary) => {
        if (this.conn !== c) return
        if (binary) return this.audioChunk(c, data)
        let msg: FromApp
        try {
          msg = JSON.parse(data.toString('utf8')) as FromApp
        } catch {
          return
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return
        if (msg.t === 'hello') {
          if (msg.programId !== undefined || msg.testo !== undefined) this.setMeta(msg.programId, msg.testo)
          // dopo una caduta: l'app dice se chi è fuori vuole ancora essere in onda
          if (typeof msg.inOnda === 'boolean' && msg.inOnda !== this.inOnda) void this.setOnda(msg.inOnda)
          else this.emit()
        } else if (msg.t === 'onda') {
          void this.setOnda(msg.on === true)
        } else if (msg.t === 'meta') {
          this.setMeta(msg.programId, msg.testo)
        }
      },
      close: () => {
        if (this.conn !== c) return
        this.conn = null
        this.stopAudio(c)
        this.log(`${c.user} si è scollegato${this.inOnda ? ': resta in onda per un minuto, se torna' : ''}`)
        if (this.inOnda) {
          this.offTimer = setTimeout(() => {
            this.offTimer = null
            if (!this.conn && this.inOnda) {
              this.log('l\'app non è tornata: fuori onda')
              void this.setOnda(false)
            }
          }, this.d.offDelayMs ?? 60_000)
        }
        this.emit()
      }
    }
  }

  private audioChunk(c: Conn, data: Buffer): void {
    if (!c.proc) {
      // un pezzo che non è l'inizio di un file WebM (app che riprende a metà) non si può leggere: si aspetta l'inizio
      if (data.length < 4 || data.readUInt32BE(0) !== 0x1a45dfa3) return
      this.startAudio(c)
    }
    const stdin = c.proc?.stdin
    if (!stdin) return
    if (c.pending > MAX_PENDING_BYTES) return
    c.pending += data.length
    stdin.write(data, () => {
      c.pending -= data.length
    })
  }

  private startAudio(c: Conn): void {
    const url = this.d.icecastUrl
    if (!url) return
    const p = this.spawn(this.d.ffmpeg ?? 'ffmpeg', ffmpegArgs(url), { stdio: ['pipe', 'ignore', 'ignore'] })
    c.proc = p
    c.pending = 0
    p.stdin?.on('error', () => {})
    p.on('error', (e) => {
      this.log(`ffmpeg non avviato: ${e.message}`)
      if (c.proc === p) c.proc = null
    })
    p.on('exit', (code) => {
      if (c.proc !== p) return
      c.proc = null
      // il prossimo pezzo con l'inizio del file (l'app ricomincia da capo quando si ricollega) lo riapre
      this.log(`audio dell'app interrotto (ffmpeg ${code})`)
      if (this.conn === c) this.sendTo(c.peer, { t: 'errore', messaggio: 'riavvio dell\'audio' })
      if (this.conn === c) c.peer.close(4011, 'audio interrotto')
    })
  }

  private stopAudio(c: Conn): void {
    const p = c.proc
    c.proc = null
    if (!p) return
    try {
      p.stdin?.end()
    } catch {
      // già chiuso
    }
    setTimeout(() => p.kill(), 1000)
  }

  private setMeta(programId: unknown, testo: unknown): void {
    const id = typeof programId === 'string' && programId && this.d.programTitle(programId) !== null ? programId : null
    const t = pulisciTesto(testo)
    if (id === this.programId && t === this.testo) return this.emit()
    this.programId = id
    this.testo = t
    if (!this.song) void this.sendTitle()
    this.emit()
  }

  /** Titolo in onda a Liquidsoap (e alle app degli ascoltatori). */
  private async sendTitle(): Promise<void> {
    const s = this.song
    const meta = s ? { artist: s.artist, title: s.title } : { artist: '', title: this.titolo() }
    await this.d.lq('/app/metadata', meta)
    if (this.effective && !s) this.d.onTitle?.(this.titolo())
  }

  /** Brano riconosciuto durante l'esterna: titolo e artista per i secondi che restano, poi torna il programma. */
  brano(artist: string, title: string, remainingSec: number): void {
    if (!this.effective) return
    if (this.songTimer) clearTimeout(this.songTimer)
    this.song = { artist, title }
    void this.sendTitle()
    this.songTimer = setTimeout(() => {
      this.songTimer = null
      this.song = null
      void this.sendTitle()
    }, Math.max(15, Math.min(15 * 60, remainingSec)) * 1000)
  }

  /** IN ONDA / FUORI ONDA. */
  async setOnda(on: boolean): Promise<void> {
    if (on && !this.conn) return
    const ok = await this.d.lq('/app/onda', { on })
    if (!ok) {
      this.log(`il mixer non ha confermato ${on ? 'IN ONDA' : 'FUORI ONDA'}`)
      if (this.conn) this.sendTo(this.conn.peer, { t: 'errore', messaggio: `Il server non ha confermato ${on ? 'IN ONDA' : 'FUORI ONDA'}: riprova.` })
      // fuori onda non confermato: si riprova, la regia deve tornare
      if (!on) setTimeout(() => void (!this.inOnda ? this.d.lq('/app/onda', { on: false }) : null), 3000)
      this.emit()
      return
    }
    if (on !== this.inOnda) this.log(`${this.user ?? '?'}: ${on ? 'IN ONDA' : 'fuori onda'}`)
    this.inOnda = on
    if (!on && this.offTimer) {
      clearTimeout(this.offTimer)
      this.offTimer = null
    }
    // il titolo si rimanda quando si entra in onda (dopo la dissolvenza): così è quello giusto anche dopo una caduta
    if (on) setTimeout(() => void this.sendTitle(), 1500)
    this.update()
  }

  /** Evento di Liquidsoap: l'audio dell'app arriva (o non arriva più) all'ingresso interno. */
  setAudio(on: boolean): void {
    if (on === this.audio) return
    this.audio = on
    this.update()
  }

  /** Stato letto da Liquidsoap all'avvio del controllo: l'app resta fuori onda finché qualcuno non preme IN ONDA. */
  sync(audio: boolean): void {
    this.audio = audio
    // dopo un riavvio del controllo nessuno sa chi era in onda: si spegne
    void this.d.lq('/app/onda', { on: false })
    this.update()
  }

  private update(): void {
    const eff = this.inOnda && this.audio
    if (eff !== this.effective) {
      this.effective = eff
      if (eff) this.since ??= this.now()
      if (!this.inOnda) this.since = null
      if (!eff && this.songTimer) {
        clearTimeout(this.songTimer)
        this.songTimer = null
        this.song = null
      }
      this.d.onAir(eff, this.user ?? '', this.titolo())
    }
    if (!this.inOnda) this.since = null
    this.emit()
  }

  private emit(): void {
    const s = this.status()
    this.d.onChange?.(s)
    if (this.conn) this.sendTo(this.conn.peer, { t: 'stato', stato: s, regia: this.d.studioConnected?.() ?? false })
  }

  /** Regia collegata o scollegata: l'app lo mostra. */
  studioChanged(): void {
    this.emit()
  }

  private sendTo(peer: AppPeer, m: ToApp): void {
    try {
      peer.send(JSON.stringify(m))
    } catch {
      // connessione già chiusa
    }
  }
}
