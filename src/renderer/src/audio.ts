import { rateRampSeconds, type MixPlan } from '../../core/djMix'
import type { AudioBackend, Player } from '../../core/playout'
import type { Track } from '../../core/types'

const dbToGain = (db: number): number => Math.pow(10, db / 20)

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

/** Uscita audio basata su Web Audio: un lettore per brano, tutti mixati nello stesso contesto. */
export class WebAudioBackend implements AudioBackend {
  readonly ctx: SinkContext
  readonly master: GainNode
  readonly analyser: AnalyserNode

  constructor(private mediaUrl: (t: Track) => string) {
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
    return new WebPlayer(this.ctx, this.master, this.mediaUrl(track), track, dbToGain(gainDb))
  }

  /**
   * Mix DJ: aggancia `to` (che entra) a `from` (che esce). Con il loop serve il brano che esce decodificato
   * in memoria, per ripetere le battute senza scatti.
   */
  async startMix(from: Player, to: Player, plan: MixPlan): Promise<void> {
    if (!(from instanceof WebPlayer) || !(to instanceof WebPlayer)) throw new Error('lettori non adatti al Mix DJ')
    let loopBuf: AudioBuffer | null = null
    if (plan.loop) {
      const data = await (await fetch(from.url)).arrayBuffer()
      loopBuf = await this.ctx.decodeAudioData(data)
    }
    const rateA = from.rate()
    const t0 = this.ctx.currentTime + (plan.aStart - from.position()) / rateA
    if (t0 - this.ctx.currentTime < 0.5) throw new Error('troppo tardi per agganciare il battito')
    from.mixOut(plan, t0, rateA, loopBuf)
    try {
      await to.startMix(plan, t0, rateA)
    } catch (e) {
      // il brano che entra non è partito: quello che esce torna normale (sfuma alla fine come sempre)
      from.cancelMix()
      throw e
    }
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

/** Attesa massima perché un file (o un flusso) sia pronto a partire. */
const START_TIMEOUT_MS = 15_000
/** Frequenza sotto la quale si tolgono i bassi nel Mix DJ. */
const BASS_HZ = 200
/** Quanto si abbassano i bassi del brano che non li "tiene" nel Mix DJ (dB). */
const BASS_CUT_DB = -30

/** Converte un istante del contesto audio in millisecondi da adesso. */
const msUntil = (ctx: AudioContext, t: number): number => Math.max(0, (t - ctx.currentTime) * 1000)

export class WebPlayer implements Player {
  private audio: HTMLAudioElement
  private source: MediaElementAudioSourceNode | null = null
  /** Volume del solo file (per passare al loop senza toccare il resto). */
  private mediaGain: GainNode
  /** Bassi (Mix DJ). */
  private bass: BiquadFilterNode
  private gain: GainNode
  private endedCbs: (() => void)[] = []
  private done = false
  private fadeTimer: ReturnType<typeof setTimeout> | null = null
  private timers: ReturnType<typeof setTimeout | typeof setInterval>[] = []
  private loopSource: AudioBufferSourceNode | null = null

  constructor(
    private ctx: AudioContext,
    destination: AudioNode,
    readonly url: string,
    private track: Track,
    private level: number
  ) {
    this.audio = new Audio()
    this.audio.crossOrigin = 'anonymous'
    this.audio.preload = 'auto'
    this.audio.src = url
    this.mediaGain = ctx.createGain()
    this.bass = ctx.createBiquadFilter()
    this.bass.type = 'lowshelf'
    this.bass.frequency.value = BASS_HZ
    this.bass.gain.value = 0
    this.gain = ctx.createGain()
    this.gain.gain.value = level
    this.mediaGain.connect(this.bass)
    this.bass.connect(this.gain)
    this.gain.connect(destination)
    this.audio.addEventListener('ended', () => this.finish())
    this.audio.addEventListener('timeupdate', () => {
      // fine dell'audio utile: il silenzio finale non va in onda
      const end = this.track.cueOut > this.track.cueIn ? this.track.cueOut : 0
      if (end && this.audio.currentTime >= end - 0.05) this.finish()
    })
  }

  /** Apre il file e lo collega al mixer, senza farlo suonare. */
  private async load(): Promise<void> {
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
      // un flusso o una cartella di rete bloccati non devono fermare la messa in onda
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('il file non risponde'))
      }, START_TIMEOUT_MS)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.audio.removeEventListener('loadedmetadata', ok)
        this.audio.removeEventListener('error', ko)
      }
      this.audio.addEventListener('loadedmetadata', ok)
      this.audio.addEventListener('error', ko)
    })
    this.source = this.ctx.createMediaElementSource(this.audio)
    this.source.connect(this.mediaGain)
  }

  async start(): Promise<void> {
    try {
      await this.load()
      if (this.track.cueIn > 0) this.audio.currentTime = this.track.cueIn
      await this.audio.play()
    } catch (e) {
      // avvio fallito: liberiamo audio e volume senza segnalare la fine (il brano non è mai partito)
      this.release()
      throw e
    }
    this.audio.addEventListener('error', () => this.finish())
  }

  position(): number {
    return this.audio.currentTime
  }

  /** Velocità attuale (1 = normale; diversa durante e subito dopo un Mix DJ). */
  rate(): number {
    return this.audio.playbackRate
  }

  /**
   * Mix DJ, brano che entra: parte in anticipo senza volume, si aggancia alla griglia (piccole correzioni
   * di velocità, senza cambiare intonazione) e all'istante `t0` del contesto audio entra senza bassi.
   * Si risolve a `t0`, quando il brano comincia a sentirsi.
   */
  async startMix(plan: MixPlan, t0: number, rateA: number): Promise<void> {
    const rate = plan.rate * rateA
    const target = (t: number): number => plan.bStart + rate * (t - t0)
    try {
      await this.load()
      this.audio.preservesPitch = true
      this.audio.playbackRate = rate
      const g = this.gain.gain
      g.cancelScheduledValues(0)
      g.setValueAtTime(0, this.ctx.currentTime)
      g.setValueAtTime(0, t0)
      g.linearRampToValueAtTime(this.level, t0 + plan.seconds / 4)
      const b = this.bass.gain
      b.setValueAtTime(BASS_CUT_DB, this.ctx.currentTime)
      b.setValueAtTime(BASS_CUT_DB, t0 + plan.bassSwapAt)
      b.linearRampToValueAtTime(0, t0 + plan.bassSwapAt + plan.barSeconds / 4)
      // se il punto di partenza è prima dell'inizio del file si aspetta
      const wait = Math.max(0, -target(this.ctx.currentTime + 0.1) / rate)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000))
      if (this.done) throw new Error('fermato')
      this.audio.currentTime = Math.max(0, target(this.ctx.currentTime + 0.1))
      await this.audio.play()
    } catch (e) {
      this.release()
      throw e
    }
    this.audio.addEventListener('error', () => this.finish())

    // aggancio: corregge la posizione con la velocità finché dura il mix
    const mixEnd = t0 + plan.seconds
    const lock = setInterval(() => {
      if (this.done) return clearInterval(lock)
      const now = this.ctx.currentTime
      if (now >= mixEnd) {
        clearInterval(lock)
        this.rampRate(rate, rateRampSeconds(plan))
        return
      }
      const err = this.audio.currentTime - target(now)
      if (Math.abs(err) > 0.25 && now < t0 - 0.5) {
        this.audio.currentTime = Math.max(0, target(now + 0.05))
        return
      }
      this.audio.playbackRate = rate * (1 - Math.max(-0.03, Math.min(0.03, err * 0.8)))
    }, 40)
    this.timers.push(lock)
    await new Promise((r) => setTimeout(r, msUntil(this.ctx, t0)))
    if (this.done) throw new Error('fermato')
  }

  /** Riporta piano piano la velocità a 1 (inudibile su qualche battuta). */
  private rampRate(from: number, seconds: number): void {
    if (seconds <= 0 || from === 1) {
      this.audio.playbackRate = 1
      return
    }
    const t0 = this.ctx.currentTime
    const step = setInterval(() => {
      if (this.done) return clearInterval(step)
      const k = Math.min(1, (this.ctx.currentTime - t0) / seconds)
      this.audio.playbackRate = from + (1 - from) * k
      if (k >= 1) clearInterval(step)
    }, 100)
    this.timers.push(step)
  }

  /**
   * Mix DJ, brano che esce: dall'istante `t0` toglie i bassi a metà mix, sfuma nella seconda metà e si ferma
   * alla fine. Con il loop, arrivato alla fine della zona da ripetere continua dal buffer `loopBuf` in loop.
   */
  mixOut(plan: MixPlan, t0: number, rateA: number, loopBuf: AudioBuffer | null): void {
    const end = t0 + plan.seconds
    const g = this.gain.gain
    g.cancelScheduledValues(0)
    g.setValueAtTime(g.value, this.ctx.currentTime)
    g.setValueAtTime(this.level, t0 + plan.seconds / 2)
    g.linearRampToValueAtTime(0, end)
    const b = this.bass.gain
    b.setValueAtTime(0, t0 + plan.bassSwapAt)
    b.linearRampToValueAtTime(BASS_CUT_DB, t0 + plan.bassSwapAt + plan.barSeconds / 4)
    if (plan.loop && loopBuf) {
      const tSwitch = t0 + (plan.loop.end - plan.loop.start) / rateA
      const src = this.ctx.createBufferSource()
      src.buffer = loopBuf
      src.loop = true
      src.loopStart = plan.loop.start
      src.loopEnd = plan.loop.end
      src.playbackRate.value = rateA
      const lg = this.ctx.createGain()
      lg.gain.setValueAtTime(0, this.ctx.currentTime)
      lg.gain.setValueAtTime(0, tSwitch - 0.004)
      lg.gain.linearRampToValueAtTime(1, tSwitch + 0.004)
      src.connect(lg)
      lg.connect(this.bass)
      src.start(tSwitch - 0.004, plan.loop.start - 0.004 * rateA)
      src.stop(end + 0.1)
      this.loopSource = src
      const m = this.mediaGain.gain
      m.setValueAtTime(1, tSwitch - 0.004)
      m.linearRampToValueAtTime(0, tSwitch + 0.004)
      this.timers.push(setTimeout(() => this.audio.pause(), msUntil(this.ctx, tSwitch) + 50))
    }
    this.timers.push(setTimeout(() => this.finish(), msUntil(this.ctx, end) + 30))
  }

  /** Annulla un Mix DJ preparato con mixOut (il brano che entra non è partito). */
  cancelMix(): void {
    if (this.done) return
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>)
    this.timers = []
    try {
      this.loopSource?.stop()
    } catch {
      // già fermo
    }
    this.loopSource?.disconnect()
    this.loopSource = null
    const now = this.ctx.currentTime
    for (const [p, v] of [
      [this.gain.gain, this.level],
      [this.bass.gain, 0],
      [this.mediaGain.gain, 1]
    ] as const) {
      p.cancelScheduledValues(now)
      p.setValueAtTime(v, now)
    }
    if (this.audio.paused) void this.audio.play()
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
    this.release()
    for (const cb of this.endedCbs) cb()
  }

  private release(): void {
    this.done = true
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>)
    this.timers = []
    try {
      this.loopSource?.stop()
    } catch {
      // già fermo
    }
    this.loopSource?.disconnect()
    this.audio.pause()
    this.source?.disconnect()
    this.mediaGain.disconnect()
    this.bass.disconnect()
    this.gain.disconnect()
    this.audio.removeAttribute('src')
    this.audio.load()
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
