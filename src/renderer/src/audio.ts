import type { AudioBackend, Player } from '../../core/playout'
import type { Track } from '../../core/types'

const dbToGain = (db: number): number => Math.pow(10, db / 20)

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

/** Uscita audio basata su Web Audio: un lettore per brano, tutti mixati nello stesso contesto. */
export class WebAudioBackend implements AudioBackend {
  readonly ctx: SinkContext
  readonly master: GainNode
  readonly analyser: AnalyserNode

  constructor(private mediaUrl: (id: number) => string) {
    this.ctx = new AudioContext({ latencyHint: 'playback' }) as SinkContext
    this.master = this.ctx.createGain()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.master.connect(this.analyser)
    this.master.connect(this.ctx.destination)
  }

  /** Sceglie la scheda audio di uscita (per esempio il RodeCaster). '' = predefinita di Windows. */
  async setOutputDevice(deviceId: string): Promise<void> {
    if (this.ctx.setSinkId) await this.ctx.setSinkId(deviceId)
  }

  createPlayer(track: Track, gainDb: number): Player {
    return new WebPlayer(this.ctx, this.master, this.mediaUrl(track.id), track, dbToGain(gainDb))
  }

  /** Livello di picco attuale (0..1) per il VU meter. */
  peak(): number {
    const buf = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(buf)
    let max = 0
    for (const v of buf) max = Math.max(max, Math.abs(v))
    return max
  }
}

class WebPlayer implements Player {
  private audio: HTMLAudioElement
  private source: MediaElementAudioSourceNode | null = null
  private gain: GainNode
  private endedCbs: (() => void)[] = []
  private done = false
  private fadeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private ctx: AudioContext,
    destination: AudioNode,
    url: string,
    private track: Track,
    level: number
  ) {
    this.audio = new Audio()
    this.audio.crossOrigin = 'anonymous'
    this.audio.preload = 'auto'
    this.audio.src = url
    this.gain = ctx.createGain()
    this.gain.gain.value = level
    this.gain.connect(destination)
    this.audio.addEventListener('ended', () => this.finish())
    this.audio.addEventListener('timeupdate', () => {
      // fine dell'audio utile: il silenzio finale non va in onda
      const end = this.track.cueOut > this.track.cueIn ? this.track.cueOut : 0
      if (end && this.audio.currentTime >= end - 0.05) this.finish()
    })
  }

  async start(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    await new Promise<void>((resolve, reject) => {
      if (this.audio.readyState >= 1) return resolve()
      const ok = (): void => {
        cleanup()
        resolve()
      }
      const ko = (): void => {
        cleanup()
        reject(new Error('file non leggibile'))
      }
      const cleanup = (): void => {
        this.audio.removeEventListener('loadedmetadata', ok)
        this.audio.removeEventListener('error', ko)
      }
      this.audio.addEventListener('loadedmetadata', ok)
      this.audio.addEventListener('error', ko)
    })
    this.source = this.ctx.createMediaElementSource(this.audio)
    this.source.connect(this.gain)
    if (this.track.cueIn > 0) this.audio.currentTime = this.track.cueIn
    await this.audio.play()
    this.audio.addEventListener('error', () => this.finish())
  }

  position(): number {
    return this.audio.currentTime
  }

  fadeOut(seconds: number): void {
    if (this.done) return
    const now = this.ctx.currentTime
    const g = this.gain.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(0, now + Math.max(0.05, seconds))
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    this.fadeTimer = setTimeout(() => this.finish(), Math.max(50, seconds * 1000))
  }

  stop(): void {
    this.finish()
  }

  onEnded(cb: () => void): void {
    this.endedCbs.push(cb)
  }

  private finish(): void {
    if (this.done) return
    this.done = true
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    this.audio.pause()
    this.source?.disconnect()
    this.gain.disconnect()
    this.audio.removeAttribute('src')
    this.audio.load()
    for (const cb of this.endedCbs) cb()
  }
}

/** Preascolto in cuffia su una scheda audio separata (per esempio un canale del RodeCaster). */
export class PreviewPlayer {
  private audio = new Audio()
  trackId: number | null = null

  async setOutputDevice(deviceId: string): Promise<void> {
    const a = this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    if (a.setSinkId) await a.setSinkId(deviceId)
  }

  async play(url: string, trackId: number, from = 0): Promise<void> {
    this.audio.src = url
    this.trackId = trackId
    this.audio.currentTime = from
    await this.audio.play()
  }

  /** Salta agli ultimi secondi del brano per sentire il finale. */
  jumpToEnd(seconds = 15): void {
    if (Number.isFinite(this.audio.duration)) this.audio.currentTime = Math.max(0, this.audio.duration - seconds)
  }

  stop(): void {
    this.audio.pause()
    this.trackId = null
  }

  get playing(): boolean {
    return !this.audio.paused
  }

  position(): number {
    return this.audio.currentTime
  }
}

/** Schede audio di uscita disponibili. Chiede una volta il permesso per vedere i nomi. */
export async function listOutputDevices(): Promise<{ deviceId: string; label: string }[]> {
  let devices = await navigator.mediaDevices.enumerateDevices()
  if (devices.some((d) => d.kind === 'audiooutput' && !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
      devices = await navigator.mediaDevices.enumerateDevices()
    } catch {
      // senza permesso restano i nomi generici
    }
  }
  return devices
    .filter((d) => d.kind === 'audiooutput')
    .map((d, i) => ({ deviceId: d.deviceId === 'default' ? '' : d.deviceId, label: d.label || `Uscita ${i + 1}` }))
}
