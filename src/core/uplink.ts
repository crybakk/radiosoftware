import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface UplinkConfig {
  host: string
  srtPort: number
  passphrase: string
  /** Latenza SRT in millisecondi: più alta = più tollerante ai buchi del 4G. */
  latencyMs: number
  bitrateKbps: number
}

export type UplinkState = 'spento' | 'connessione' | 'collegato' | 'riconnessione'

export interface UplinkStatus {
  state: UplinkState
  message: string
  /** Quando è iniziato il collegamento attuale (ISO). */
  connectedSince: string | null
  reconnects: number
  /** Secondi alla prossima riconnessione. */
  retryIn: number | null
  kbps: number
}

/** Argomenti di ffmpeg: PCM 16 bit stereo da stdin → Opus in MPEG-TS → SRT verso il ponte. */
export function buildFfmpegArgs(c: UplinkConfig, sampleRate: number): string[] {
  const params = new URLSearchParams({
    mode: 'caller',
    latency: String(Math.round(c.latencyMs * 1000)),
    pkt_size: '1316',
    connect_timeout: '5000'
  })
  if (c.passphrase) params.set('passphrase', c.passphrase)
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', '2',
    '-i', 'pipe:0',
    '-c:a', 'libopus',
    '-b:a', `${c.bitrateKbps}k`,
    '-application', 'audio',
    '-frame_duration', '20',
    '-f', 'mpegts',
    '-flush_packets', '1',
    '-progress', 'pipe:1',
    '-stats_period', '1',
    `srt://${c.host}:${c.srtPort}?${params.toString()}`
  ]
}

/** Traduce gli errori di ffmpeg/SRT in un messaggio comprensibile. */
export function explainError(stderr: string): string {
  if (/Incorrect passphrase|passphrase/i.test(stderr) && /REJECT|reject/i.test(stderr)) return 'Frase segreta errata'
  if (/Unknown encoder|libopus/i.test(stderr) && /not found|Unknown/i.test(stderr)) return 'Codifica Opus non disponibile'
  if (/Connection setup failure|connection timed out|Connection timed out/i.test(stderr)) return 'Il ponte non risponde'
  if (/Connection.*failed|Input\/output error/i.test(stderr)) return 'Il ponte non risponde'
  if (/Name or service not known|getaddrinfo|Failed to resolve/i.test(stderr)) return 'Indirizzo del ponte non trovato'
  if (/Connection was broken|Broken pipe|Connection reset/i.test(stderr)) return 'Collegamento interrotto'
  const last = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
  return last ? last.replace(/^\[[^\]]+\]\s*/, '').slice(0, 160) : 'Collegamento interrotto'
}

/** Attesa prima del tentativo n (1, 2, 3…): 2, 4, 8, 16, 30, 30… secondi. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30, 2 ** Math.max(1, attempt))
}

/**
 * Invio del programma al ponte. Riceve PCM dall'interfaccia e lo passa a ffmpeg.
 * Se il collegamento cade, riprova da solo con attese crescenti, all'infinito.
 * Durante la riconnessione l'audio non inviato va perso: AzuraCast nel frattempo
 * suona la sua AutoDJ di riserva.
 */
export class Uplink {
  private proc: ChildProcessWithoutNullStreams | null = null
  private config: UplinkConfig | null = null
  private sampleRate = 48000
  private wanted = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAt: number | null = null
  private stderr = ''
  private lastBytes = 0
  private lastBytesAt = 0
  private status: UplinkStatus = { state: 'spento', message: 'Invio al ponte spento', connectedSince: null, reconnects: 0, retryIn: null, kbps: 0 }
  private listeners = new Set<(s: UplinkStatus) => void>()
  private ffmpegPath: string

  constructor(ffmpegPath: string) {
    this.ffmpegPath = ffmpegPath
  }

  onStatus(cb: (s: UplinkStatus) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getStatus(): UplinkStatus {
    return { ...this.status, retryIn: this.retryAt ? Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000)) : null }
  }

  private set(patch: Partial<UplinkStatus>): void {
    this.status = { ...this.status, ...patch }
    const s = this.getStatus()
    for (const l of this.listeners) l(s)
  }

  start(config: UplinkConfig, sampleRate: number): void {
    const changed = JSON.stringify(config) !== JSON.stringify(this.config) || sampleRate !== this.sampleRate
    this.config = config
    this.sampleRate = sampleRate
    this.wanted = true
    if (this.proc && !changed) return
    this.attempt = 0
    this.killProc()
    this.clearRetry()
    this.launch()
  }

  stop(): void {
    this.wanted = false
    this.clearRetry()
    this.killProc()
    this.set({ state: 'spento', message: 'Invio al ponte spento', connectedSince: null, kbps: 0 })
  }

  /** Audio PCM s16le stereo interleaved. Se non collegati viene scartato. */
  write(pcm: Uint8Array): void {
    const p = this.proc
    if (!p || p.stdin.destroyed || !p.stdin.writable) return
    // se ffmpeg è bloccato (rete ferma) non accumuliamo memoria all'infinito
    if (p.stdin.writableLength > 2 * 1024 * 1024) return
    p.stdin.write(pcm)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryAt = null
  }

  private killProc(): void {
    const p = this.proc
    this.proc = null
    if (p) {
      p.removeAllListeners()
      p.stdout.removeAllListeners()
      p.stderr.removeAllListeners()
      p.stdin.on('error', () => {})
      p.on('error', () => {})
      p.kill('SIGKILL')
    }
  }

  private launch(): void {
    if (!this.config || !this.wanted) return
    this.stderr = ''
    this.lastBytes = 0
    this.lastBytesAt = Date.now()
    this.set({ state: this.attempt ? 'riconnessione' : 'connessione', message: 'Collegamento al ponte…', kbps: 0 })
    const proc = spawn(this.ffmpegPath, buildFfmpegArgs(this.config, this.sampleRate), { windowsHide: true })
    this.proc = proc
    proc.stdin.on('error', () => {})
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-4000)
    })
    proc.stdout.setEncoding('utf8')
    let buf = ''
    proc.stdout.on('data', (d: string) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        const m = /^total_size=(\d+)/.exec(line)
        if (!m) continue
        const bytes = Number(m[1])
        const now = Date.now()
        if (bytes > this.lastBytes) {
          const kbps = Math.round(((bytes - this.lastBytes) * 8) / Math.max(0.2, (now - this.lastBytesAt) / 1000) / 1000)
          if (this.status.state !== 'collegato') {
            this.attempt = 0
            this.set({ state: 'collegato', message: 'Collegato al ponte', connectedSince: new Date().toISOString(), kbps })
          } else {
            this.set({ kbps })
          }
          this.lastBytes = bytes
          this.lastBytesAt = now
        }
      }
    })
    proc.on('error', (err) => this.onExit(`ffmpeg non avviato: ${err.message}`))
    proc.on('close', () => this.onExit(explainError(this.stderr)))
  }

  private onExit(message: string): void {
    if (!this.proc) return
    this.proc = null
    if (!this.wanted) return
    const wasConnected = this.status.state === 'collegato'
    this.attempt++
    const wait = backoffSeconds(this.attempt)
    this.retryAt = Date.now() + wait * 1000
    this.set({
      state: 'riconnessione',
      message,
      connectedSince: null,
      kbps: 0,
      reconnects: this.status.reconnects + (wasConnected ? 1 : 0)
    })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryAt = null
      this.launch()
    }, wait * 1000)
  }
}
