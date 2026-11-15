/**
 * Dirette video verso YouTube e Facebook, avviate a mano dal pannello quando servono.
 *
 * - Immagine: il logo caricato dal pannello (ricodificato a 720p, pochissimo lavoro per il server)
 *   oppure il video che arriva da OBS in SRT (inoltrato così com'è, senza ricodifica: massimo 720p).
 * - Audio: il programma del ponte (lo stesso degli Icecast), con un ritardo regolabile
 *   per allinearlo al video di OBS.
 * - Un solo ffmpeg manda a tutte le destinazioni scelte: se una cade, le altre continuano.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { VideoCommand, VideoDestination, VideoSource, VideoStatus } from './protocol.ts'

export const MAX_HEIGHT = 720
const YOUTUBE_URL = 'rtmp://a.rtmp.youtube.com/live2/'
const FACEBOOK_URL = 'rtmps://live-api-s.facebook.com:443/rtmp/'
/** Ripartenze automatiche se ffmpeg si ferma da solo. */
const MAX_RETRIES = 5
const RETRY_MS = 5000
/** Dopo quanto tempo in onda senza problemi i tentativi ripartono da zero. */
const STABLE_MS = 60_000
/** Se ffmpeg non si ferma con SIGTERM entro questo tempo, si chiude con SIGKILL. */
const KILL_MS = 5000

export interface VideoConfig {
  youtubeKey: string
  facebookUrl: string
  facebookKey: string
  /** Millisecondi: positivo = audio più tardi del video; negativo = video più tardi dell'audio. */
  delayMs: number
}

export interface VideoArgsInput {
  source: VideoSource
  logo: string
  obsUrl: string
  audioUrl: string
  delayMs: number
  outputs: string[]
}

export interface ChildLike {
  stderr: { on(ev: 'data', cb: (d: Buffer) => void): unknown } | null
  on(ev: 'exit', cb: (code: number | null) => void): unknown
  /** ffmpeg non si avvia (per esempio non installato): senza questo il servizio cadrebbe. */
  on(ev: 'error', cb: (e: Error) => void): unknown
  kill(sig?: NodeJS.Signals): unknown
}

export type SpawnFn = (cmd: string, args: string[]) => ChildLike

export interface VideoOptions {
  file: string
  /** Percorso dell'immagine del logo, se caricata. */
  logo: () => string | null
  audioUrl: string
  obsPort: number
  obsPassphrase: string
  spawn?: SpawnFn
  now?: () => number
  ffmpeg?: string
}

const KEY_RE = /^[A-Za-z0-9_\-.?=&]{4,200}$/

/** Argomenti di ffmpeg (funzione pura, per i test). */
export function ffmpegArgs(i: VideoArgsInput): string[] {
  const sec = (ms: number): string => (Math.abs(ms) / 1000).toFixed(3)
  const audioIn = ['-thread_queue_size', '1024', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']
  if (i.delayMs > 0) audioIn.push('-itsoffset', sec(i.delayMs))
  audioIn.push('-i', i.audioUrl)
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', '-stats_period', '5', '-stats']
  if (i.source === 'logo') {
    args.push('-re', '-loop', '1', '-framerate', '15', '-i', i.logo, ...audioIn)
    args.push(
      '-map', '0:v', '-map', '1:a',
      '-vf', `scale=1280:${MAX_HEIGHT}:force_original_aspect_ratio=decrease,pad=1280:${MAX_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-r', '15', '-g', '30', '-keyint_min', '30',
      '-b:v', '1500k', '-maxrate', '1500k', '-bufsize', '3000k'
    )
  } else {
    const videoIn = ['-thread_queue_size', '1024']
    if (i.delayMs < 0) videoIn.push('-itsoffset', sec(i.delayMs))
    args.push(...videoIn, '-i', i.obsUrl, ...audioIn)
    // tag 7 = H.264 per FLV: dentro 'tee' ffmpeg non converte da solo il tag di MPEG-TS (27)
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-tag:v', '7')
  }
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-flags', '+global_header', '-max_muxing_queue_size', '1024')
  args.push('-f', 'tee', i.outputs.map((u) => `[f=flv:onfail=ignore]${u}`).join('|'))
  return args
}

/** Dalla riga di ffmpeg "Stream #0:0: Video: h264 (High), yuv420p, 1280x720 ..." → codec e altezza. */
export function parseVideoStream(line: string): { codec: string; width: number; height: number } | null {
  const m = /Stream #0:\d+.*?: Video: (\w+).*?\b(\d{2,5})x(\d{2,5})\b/.exec(line)
  return m ? { codec: m[1], width: Number(m[2]), height: Number(m[3]) } : null
}

export class VideoLive {
  private cfg: VideoConfig
  private st: VideoStatus
  private child: ChildLike | null = null
  private wanted: { source: VideoSource; destinations: VideoDestination[]; by: string } | null = null
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stderrTail = ''
  private readonly o: VideoOptions
  private readonly spawn: SpawnFn
  private readonly now: () => number
  onChange: (s: VideoStatus) => void = () => {}
  /** Messaggi importanti (diretta interrotta): vanno anche su Telegram/email. */
  onAlert: (text: string) => void = () => {}
  /** Righe di errore di ffmpeg, per il registro del servizio. */
  onLog: (line: string) => void = () => {}

  constructor(o: VideoOptions) {
    this.o = o
    this.now = o.now ?? (() => Date.now())
    this.spawn =
      o.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }) as unknown as ChildLike)
    this.cfg = { youtubeKey: '', facebookUrl: FACEBOOK_URL, facebookKey: '', delayMs: 0 }
    if (existsSync(o.file)) {
      try {
        Object.assign(this.cfg, JSON.parse(readFileSync(o.file, 'utf8')) as Partial<VideoConfig>)
      } catch {
        // file rovinato: si riparte senza chiavi
      }
    }
    this.st = {
      state: 'spenta',
      source: null,
      destinations: [],
      since: null,
      by: null,
      error: null,
      detail: '',
      youtube: false,
      facebook: false,
      hasLogo: false,
      delayMs: 0,
      obsPort: o.obsPort,
      obsPassphrase: o.obsPassphrase !== ''
    }
  }

  status(): VideoStatus {
    return {
      ...this.st,
      youtube: this.cfg.youtubeKey !== '',
      facebook: this.cfg.facebookKey !== '',
      hasLogo: this.o.logo() !== null,
      delayMs: this.cfg.delayMs
    }
  }

  private emit(patch: Partial<VideoStatus> = {}): void {
    Object.assign(this.st, patch)
    this.onChange(this.status())
  }

  private save(): void {
    const tmp = `${this.o.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.cfg), { mode: 0o600 })
    renameSync(tmp, this.o.file)
  }

  logoChanged(): void {
    this.emit()
  }

  private outputs(dest: VideoDestination[]): string[] {
    return dest.map((d) =>
      d === 'youtube' ? `${YOUTUBE_URL}${this.cfg.youtubeKey}` : `${this.cfg.facebookUrl.replace(/\/?$/, '/')}${this.cfg.facebookKey}`
    )
  }

  private obsUrl(): string {
    const q = new URLSearchParams({ mode: 'listener', latency: '200000' })
    if (this.o.obsPassphrase) q.set('passphrase', this.o.obsPassphrase)
    return `srt://0.0.0.0:${this.o.obsPort}?${q.toString()}`
  }

  /** Comandi dal pannello. config = solo amministratori (controllato da chi chiama). */
  run(cmd: VideoCommand, by: string): unknown {
    switch (cmd.type) {
      case 'start': {
        if (this.wanted) throw new Error('la diretta video è già accesa: fermala prima di cambiarla')
        const source: VideoSource = cmd.source === 'obs' ? 'obs' : 'logo'
        const destinations = [...new Set((cmd.destinations ?? []).filter((d) => d === 'youtube' || d === 'facebook'))]
        if (!destinations.length) throw new Error('scegli almeno una destinazione (YouTube o Facebook)')
        if (destinations.includes('youtube') && !this.cfg.youtubeKey) throw new Error('manca la chiave di YouTube (Impostazioni delle dirette video)')
        if (destinations.includes('facebook') && !this.cfg.facebookKey) throw new Error('manca la chiave di Facebook (Impostazioni delle dirette video)')
        if (source === 'logo' && !this.o.logo()) throw new Error("carica prima l'immagine del logo")
        if (!this.o.audioUrl) throw new Error("manca l'indirizzo dell'audio della radio (VIDEO_AUDIO_URL nel file .env)")
        this.wanted = { source, destinations, by }
        this.retries = 0
        this.emit({ source, destinations, by, error: null, since: null })
        this.launch()
        return this.status()
      }
      case 'stop':
        this.stop(by)
        return this.status()
      case 'config': {
        if (cmd.youtubeKey != null) {
          const k = String(cmd.youtubeKey).trim()
          if (k && !KEY_RE.test(k)) throw new Error('chiave di YouTube non valida')
          this.cfg.youtubeKey = k
        }
        if (cmd.facebookKey != null) {
          const k = String(cmd.facebookKey).trim()
          if (k && !KEY_RE.test(k)) throw new Error('chiave di Facebook non valida')
          this.cfg.facebookKey = k
        }
        if (cmd.facebookUrl != null) {
          const u = String(cmd.facebookUrl).trim() || FACEBOOK_URL
          if (!/^rtmps?:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9_\-/]*$/.test(u)) throw new Error('indirizzo del server di Facebook non valido')
          this.cfg.facebookUrl = u
        }
        if (cmd.delayMs != null) {
          const d = Math.round(Number(cmd.delayMs))
          if (!Number.isFinite(d) || Math.abs(d) > 10_000) throw new Error('ritardo tra -10000 e 10000 millisecondi')
          this.cfg.delayMs = d
        }
        this.save()
        this.emit()
        return this.status()
      }
      default:
        throw new Error('comando sconosciuto')
    }
  }

  stop(by?: string): void {
    const was = this.wanted
    this.wanted = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const c = this.child
    this.child = null
    if (c) {
      // ffmpeg bloccato sulla rete può ignorare SIGTERM: non deve restare acceso (porta di OBS occupata, doppia diretta)
      const force = setTimeout(() => c.kill('SIGKILL'), KILL_MS)
      ;(force as { unref?: () => void }).unref?.()
      c.on('exit', () => clearTimeout(force))
      c.kill('SIGTERM')
    }
    if (was) this.emit({ state: 'spenta', since: null, detail: '', error: null, by: by ?? was.by })
  }

  private launch(): void {
    const w = this.wanted
    if (!w) return
    const args = ffmpegArgs({
      source: w.source,
      logo: this.o.logo() ?? '',
      obsUrl: this.obsUrl(),
      audioUrl: this.o.audioUrl,
      delayMs: this.cfg.delayMs,
      outputs: this.outputs(w.destinations)
    })
    this.stderrTail = ''
    const child = this.spawn(this.o.ffmpeg ?? 'ffmpeg', args)
    this.child = child
    this.emit({ state: w.source === 'obs' ? 'attesa_obs' : 'avvio', detail: '' })
    let buf = ''
    child.stderr?.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) this.onLine(child, line)
      }
      if (buf.length > 4096) buf = buf.slice(-1024)
    })
    child.on('exit', (code) => this.onExit(child, code))
    child.on('error', (e) => {
      if (child !== this.child) return
      this.stderrTail = `ffmpeg non si avvia: ${this.redact(e.message)}`
      this.onExit(child, null)
    })
  }

  /** Toglie chiavi e passphrase dalle righe di ffmpeg: errori e registro li vedono tutti i pannelli. */
  private redact(line: string): string {
    let out = line
    for (const k of [this.cfg.youtubeKey, this.cfg.facebookKey, this.o.obsPassphrase]) if (k) out = out.split(k).join('***')
    // anche una chiave cambiata mentre la diretta è accesa: si toglie l'ultimo pezzo degli indirizzi rtmp
    return out
      .replace(/(rtmps?:\/\/[^\s'"|/]+\/(?:[^\s'"|/]+\/)*)[^\s'"|/]+/gi, '$1***')
      .replace(/(passphrase=)[^\s&'"]+/gi, '$1***')
  }

  private onLine(child: ChildLike, raw: string): void {
    if (child !== this.child) return
    const line = this.redact(raw)
    // la causa vera è l'ultima riga di errore, non il riassunto finale "Conversion failed!"
    if (!/^frame=|^size=|Conversion failed|^Exiting normally/.test(line) && /error|fail|refused|denied|timed out|invalid|unable|could not|not found|broken pipe|end of file/i.test(line)) {
      this.stderrTail = line.slice(0, 300)
      this.onLog(line)
    }
    const v = parseVideoStream(line)
    if (v && this.wanted?.source === 'obs' && line.startsWith('Stream #0:')) {
      if (v.height > MAX_HEIGHT) return this.fail(`OBS manda ${v.width}x${v.height}: imposta in OBS la risoluzione di uscita a 1280x720 (massimo 720p)`)
      if (v.codec !== 'h264') return this.fail(`OBS manda video ${v.codec}: imposta in OBS il codificatore x264 (H.264)`)
      this.emit({ detail: `video da OBS ${v.width}x${v.height}` })
    }
    if (/^frame=|^size=/.test(line) && this.st.state !== 'in_onda') {
      this.emit({ state: 'in_onda', since: new Date(this.now()).toISOString(), error: null })
    }
  }

  private fail(msg: string): void {
    const w = this.wanted
    this.stop()
    this.emit({ state: 'errore', error: msg, by: w?.by ?? null })
  }

  private onExit(child: ChildLike, code: number | null): void {
    if (child !== this.child) return
    this.child = null
    const w = this.wanted
    if (!w) return
    // i tentativi ripartono da zero solo dopo un po' in onda: se cade sempre dopo pochi secondi non riprova all'infinito
    if (this.st.state === 'in_onda' && this.st.since && this.now() - Date.parse(this.st.since) >= STABLE_MS) this.retries = 0
    const why =
      w.source === 'obs' && this.st.state === 'in_onda'
        ? 'il video da OBS si è interrotto: riparte appena OBS trasmette di nuovo'
        : this.stderrTail || `ffmpeg è uscito (codice ${code})`
    if (this.retries >= MAX_RETRIES) {
      this.wanted = null
      this.emit({ state: 'errore', error: `diretta video fermata dopo ${MAX_RETRIES} tentativi: ${why}`, since: null })
      this.onAlert(`🎥 Diretta video fermata: non riesce a ripartire (${why}).`)
      return
    }
    this.retries++
    if (this.st.state === 'in_onda') this.onAlert(`🎥 Diretta video interrotta, riprovo: ${why}`)
    this.emit({ state: 'avvio', error: why, detail: `nuovo tentativo ${this.retries} di ${MAX_RETRIES}…` })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.launch()
    }, RETRY_MS)
  }
}
