import { mixTarget, rateRampSeconds, SPINBACK_SECONDS, type MixPlan, type MixStyle } from '../../core/djMix'
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
    // il brano che esce decodificato in memoria: serve per il loop e per sapere dove si trova davvero
    const needBuf = !!plan.loop || BUFFER_STYLES.includes(plan.style)
    let buf: AudioBuffer | null = null
    try {
      const data = await (await fetch(from.url)).arrayBuffer()
      buf = await this.ctx.decodeAudioData(data)
    } catch (e) {
      if (needBuf) throw e
    }
    // dopo un salto nel file (l'inizio dal cue) il lettore sbaglia la sua posizione: negli MP3 di qualche
    // centesimo, nei VBR anche di qualche decimo. La si misura confrontando quello che suona con il file.
    let offset = 0
    if (buf && (plan.aStart - from.position()) / from.rate() > CALIBRATE_MIN_SECONDS) offset = (await from.measureOffset(buf)) ?? 0
    const rateA = from.rate()
    const t0 = this.ctx.currentTime + (plan.aStart - (from.position() + offset)) / rateA
    // il riverbero comincia a "bagnare" il brano una battuta prima
    const lead = plan.style === 'reverb' ? plan.barSeconds / rateA : 0
    if (t0 - lead - this.ctx.currentTime < 0.5) throw new Error('troppo tardi per agganciare il battito')
    from.mixOut(plan, t0, rateA, needBuf ? buf : null)
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

/** Passaggi che suonano il brano che esce dalla memoria (loop, rullo, frenata, riavvolto). */
const BUFFER_STYLES: MixStyle[] = ['roll', 'brake', 'spinback']
/** Passaggi a tempo: il brano che entra segue quello che esce. */
const SYNCED_STYLES: MixStyle[] = ['blend', 'filter']
/** Sotto questo anticipo (secondi) non c'è tempo di misurare la posizione vera del brano che esce. */
const CALIBRATE_MIN_SECONDS = 4.5
/** Secondi di audio confrontati per misurare la posizione vera. */
const CALIBRATE_SECONDS = 2
/** Errore massimo di posizione cercato (secondi). */
const CALIBRATE_RANGE = 0.4
/**
 * Correzione massima di velocità del brano che entra: da muto (non si sente), mentre entra appena (primo sedicesimo
 * del mix, volume basso) e poi. Con la velocità diversa da 1 Chromium allunga il suono senza cambiare intonazione.
 */
const LOCK_SILENT = 0.25
const LOCK_ENTERING = 0.08
const LOCK_AUDIBLE = 0.03
/** Anticipo (secondi) con cui si chiede la partenza: il lettore ci mette un attimo, meglio arrivare prima e rallentare. */
const PLAY_EARLY = 0.04

/** Risposta all'impulso di un riverbero ampio: rumore che si spegne in `seconds`. */
function reverbImpulse(ctx: BaseAudioContext, seconds = 3.5): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  let seed = 7
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < n; i++) {
      seed = (seed * 16807) % 2147483647
      d[i] = (seed / 2147483647 - 0.5) * 2 * Math.pow(1 - i / n, 3)
    }
  }
  return buf
}

/** Converte un istante del contesto audio in millisecondi da adesso. */
const msUntil = (ctx: AudioContext, t: number): number => Math.max(0, (t - ctx.currentTime) * 1000)

export class WebPlayer implements Player {
  private audio: HTMLAudioElement
  private source: MediaElementAudioSourceNode | null = null
  /** Volume del solo file (per passare al loop senza toccare il resto). */
  private mediaGain: GainNode
  /** Bassi (Mix DJ). */
  private bass: BiquadFilterNode
  /** Filtri del Mix DJ: passa-basso e passa-alto (trasparenti finché non servono). */
  private lp: BiquadFilterNode
  private hp: BiquadFilterNode
  private gain: GainNode
  /** Effetti (eco, riverbero): mandata e ritorno, fuori dal volume del brano così la coda resta. */
  private fx: AudioNode[] = []
  private bufSources: AudioBufferSourceNode[] = []
  private endedCbs: (() => void)[] = []
  private done = false
  private fadeTimer: ReturnType<typeof setTimeout> | null = null
  private timers: ReturnType<typeof setTimeout | typeof setInterval>[] = []

  constructor(
    private ctx: AudioContext,
    private destination: AudioNode,
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
    this.lp = ctx.createBiquadFilter()
    this.lp.type = 'lowpass'
    this.lp.frequency.value = ctx.sampleRate / 2
    this.hp = ctx.createBiquadFilter()
    this.hp.type = 'highpass'
    this.hp.frequency.value = 0
    this.gain = ctx.createGain()
    this.gain.gain.value = level
    this.mediaGain.connect(this.bass)
    this.bass.connect(this.lp)
    this.lp.connect(this.hp)
    this.hp.connect(this.gain)
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
   * Mix DJ, brano che entra: parte dall'inizio del file senza volume, proprio quando serve per arrivare al suo primo
   * "uno" insieme a quello del brano che esce (niente salti nel file: dopo un salto il lettore non sa più con
   * precisione dove si trova). Poi resta agganciato battuta per battuta con piccole correzioni di velocità, senza
   * cambiare intonazione, e all'istante `t0` del contesto audio entra senza bassi. Si risolve a `t0`.
   */
  async startMix(plan: MixPlan, t0: number, rateA: number): Promise<void> {
    const synced = SYNCED_STYLES.includes(plan.style)
    // istante in cui il brano comincia a sentirsi
    const tB = t0 + plan.bIn / rateA
    /** Dove deve essere il brano all'istante `t` del contesto audio, e a che velocità. */
    const target = (t: number): { pos: number; rate: number } => {
      if (!synced) return { pos: plan.bStart + (t - tB), rate: 1 }
      const m = mixTarget(plan, (t - t0) * rateA)
      return { pos: m.pos, rate: m.rate * rateA }
    }
    let seeked = false
    try {
      await this.load()
      this.audio.preservesPitch = true
      const now = this.ctx.currentTime
      const g = this.gain.gain
      g.cancelScheduledValues(0)
      g.setValueAtTime(0, now)
      if (synced) {
        g.setValueAtTime(0, t0)
        g.linearRampToValueAtTime(this.level, t0 + plan.seconds / 4)
        const b = this.bass.gain
        b.setValueAtTime(BASS_CUT_DB, now)
        b.setValueAtTime(BASS_CUT_DB, t0 + plan.bassSwapAt)
        b.linearRampToValueAtTime(0, t0 + plan.bassSwapAt + plan.barSeconds / 4)
        if (plan.style === 'filter') {
          // entra "aprendosi": passa-alto che scende fino a metà mix
          const h = this.hp.frequency
          h.setValueAtTime(1000, now)
          h.setValueAtTime(1000, t0)
          h.exponentialRampToValueAtTime(20, t0 + plan.seconds / 2)
          h.setValueAtTime(0, t0 + plan.seconds / 2 + 0.01)
        }
      } else {
        // entra pieno, sul battito (un soffio prima, per non tagliare il colpo del primo tempo)
        g.setValueAtTime(0, tB - 0.07)
        g.linearRampToValueAtTime(this.level, tB - 0.05)
      }
      // quando partire dall'inizio del file per trovarsi al punto giusto
      const first = target(tB)
      const tStart = tB - first.pos / first.rate
      const wait = tStart - this.ctx.currentTime - PLAY_EARLY
      if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000))
      if (this.done) throw new Error('fermato')
      const late = (this.ctx.currentTime - tStart) * first.rate
      if (late > 0.05 + LOCK_SILENT * Math.max(0, tB - this.ctx.currentTime - 0.1)) {
        // troppo tardi per partire dall'inizio e recuperare prima di sentirsi: salto al punto giusto
        this.audio.currentTime = Math.max(0, target(this.ctx.currentTime + 0.1).pos)
        seeked = true
      }
      this.audio.playbackRate = first.rate
      await this.audio.play()
    } catch (e) {
      this.release()
      throw e
    }
    this.audio.addEventListener('error', () => this.finish())

    // aggancio: corregge la posizione con la velocità finché dura il mix (o poco dopo l'entrata)
    const mixEnd = synced ? t0 + plan.seconds / rateA : tB + 2
    const lock = setInterval(() => {
      if (this.done) return clearInterval(lock)
      const now = this.ctx.currentTime
      if (now >= mixEnd) {
        clearInterval(lock)
        if (synced) this.rampRate(this.audio.playbackRate, rateRampSeconds(plan))
        else this.audio.playbackRate = 1
        return
      }
      const want = target(now)
      const err = this.audio.currentTime - want.pos
      const silent = now < tB - 0.05
      const entering = synced && now < t0 + plan.seconds / rateA / 16
      // da muto un salto non si sente, ma solo se con la velocità non si recupera in tempo (dopo un salto il
      // lettore non sa più con precisione dove si trova)
      if (silent && !seeked && Math.abs(err) > 0.05 + LOCK_SILENT * Math.max(0, tB - now - 0.1)) {
        this.audio.currentTime = Math.max(0, target(now + 0.05).pos)
        seeked = true
        return
      }
      const max = silent ? LOCK_SILENT : entering ? LOCK_ENTERING : LOCK_AUDIBLE
      const k = silent ? 4 : entering ? 2 : 0.8
      this.audio.playbackRate = want.rate * (1 - Math.max(-max, Math.min(max, err * k)))
    }, 40)
    this.timers.push(lock)
    await new Promise((r) => setTimeout(r, msUntil(this.ctx, t0)))
    if (this.done) throw new Error('fermato')
  }

  /**
   * Di quanto la posizione dichiarata dal lettore è sbagliata (secondi da aggiungere a `position()`): suona di
   * nascosto lo stesso brano dalla memoria, dove il lettore dice di essere, e cerca lo scarto tra i due.
   * null se non si riesce a misurare (silenzio, velocità diversa da 1, brano quasi finito).
   */
  async measureOffset(buf: AudioBuffer): Promise<number | null> {
    if (!this.source || this.audio.paused || this.done || Math.abs(this.audio.playbackRate - 1) > 1e-3) return null
    const ctx = this.ctx
    const mono = (): GainNode => {
      const g = ctx.createGain()
      g.channelCount = 1
      g.channelCountMode = 'explicit'
      g.channelInterpretation = 'speakers'
      return g
    }
    const merger = ctx.createChannelMerger(2)
    const live = mono()
    const refGain = mono()
    const ref = ctx.createBufferSource()
    ref.buffer = buf
    const sp = ctx.createScriptProcessor(4096, 2, 1)
    const mute = ctx.createGain()
    mute.gain.value = 0
    this.source.connect(live)
    live.connect(merger, 0, 0)
    ref.connect(refGain)
    refGain.connect(merger, 0, 1)
    merger.connect(sp)
    sp.connect(mute)
    mute.connect(ctx.destination)
    const ts = ctx.currentTime + 0.1
    const from = this.audio.currentTime + (ts - ctx.currentTime)
    const total = CALIBRATE_SECONDS + 2 * CALIBRATE_RANGE + 0.2
    const cleanup = (): void => {
      try {
        ref.stop()
      } catch {
        // mai partito
      }
      for (const n of [ref, refGain, live, merger, sp, mute]) n.disconnect()
      try {
        this.source?.disconnect(live)
      } catch {
        // già staccato
      }
    }
    if (from + total + 0.5 > buf.duration) {
      cleanup()
      return null
    }
    ref.start(ts, from)
    const a: Float32Array[] = []
    const b: Float32Array[] = []
    let got = 0
    const need = Math.ceil((total + 0.3) * ctx.sampleRate)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, (total + 2) * 1000)
      sp.onaudioprocess = (ev): void => {
        a.push(new Float32Array(ev.inputBuffer.getChannelData(0)))
        b.push(new Float32Array(ev.inputBuffer.getChannelData(1)))
        got += ev.inputBuffer.length
        if (got >= need) {
          clearTimeout(timer)
          resolve()
        }
      }
    })
    sp.onaudioprocess = null
    cleanup()
    if (this.done || got < need) return null
    const lag = findLag(concat(a), concat(b), ctx.sampleRate, CALIBRATE_SECONDS, CALIBRATE_RANGE)
    return lag === null ? null : -lag
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
   * Mix DJ, brano che esce, secondo il tipo di passaggio. Nei passaggi a tempo dall'istante `t0` toglie i bassi a metà
   * mix e sfuma nella seconda metà (con il filtro si chiude anche in un passa-basso); con il loop, arrivato alla
   * fine della zona da ripetere continua dal buffer in loop. Negli altri passaggi: eco, riverbero, stacco, rullo,
   * frenata o riavvolto a partire da `t0`. In ogni caso finisce da solo alla fine.
   */
  mixOut(plan: MixPlan, t0: number, rateA: number, buf: AudioBuffer | null): void {
    const k = 1 / rateA
    const now = this.ctx.currentTime
    const end = t0 + plan.seconds * (SYNCED_STYLES.includes(plan.style) ? 1 : k)
    const beat = (plan.barSeconds / 4) * k
    const g = this.gain.gain
    g.cancelScheduledValues(0)
    g.setValueAtTime(g.value, now)
    /** Toglie il brano (volume a zero) all'istante `t`, senza scatti. */
    const cutAt = (t: number, ramp = 0.006): void => {
      g.setValueAtTime(this.level, t - ramp)
      g.linearRampToValueAtTime(0, t)
    }
    switch (plan.style) {
      case 'blend':
      case 'filter': {
        g.setValueAtTime(this.level, t0 + plan.seconds / 2)
        g.linearRampToValueAtTime(0, end)
        const b = this.bass.gain
        b.setValueAtTime(0, t0 + plan.bassSwapAt)
        b.linearRampToValueAtTime(BASS_CUT_DB, t0 + plan.bassSwapAt + plan.barSeconds / 4)
        if (plan.style === 'filter') {
          const f = this.lp.frequency
          f.setValueAtTime(this.ctx.sampleRate / 2, now)
          f.setValueAtTime(16000, t0)
          f.exponentialRampToValueAtTime(250, end)
        }
        if (plan.loop && buf) {
          const tSwitch = t0 + (plan.loop.end - plan.loop.start) * k
          this.playBuffer(buf, rateA, tSwitch, plan.loop.start, end + 0.1, { start: plan.loop.start, end: plan.loop.end })
          this.muteMediaAt(tSwitch)
        }
        break
      }
      case 'cut':
        cutAt(t0)
        break
      case 'echo': {
        // l'eco "cattura" il primo battito e lo ripete a ogni battito, sempre più piano
        const send = this.effect((input, output) => {
          const delay = this.ctx.createDelay(4)
          delay.delayTime.value = beat
          const fb = this.ctx.createGain()
          fb.gain.value = 0.55
          const tone = this.ctx.createBiquadFilter()
          tone.type = 'lowpass'
          tone.frequency.value = 3500
          input.connect(delay)
          delay.connect(tone)
          tone.connect(fb)
          fb.connect(delay)
          tone.connect(output)
          return [delay, fb, tone]
        }, t0 + plan.bIn * k, end)
        send.setValueAtTime(0, now)
        send.setValueAtTime(1, t0)
        send.setValueAtTime(1, t0 + beat - 0.01)
        send.linearRampToValueAtTime(0, t0 + beat)
        cutAt(t0 + beat, 0.02)
        break
      }
      case 'reverb': {
        const send = this.effect((input, output) => {
          const conv = this.ctx.createConvolver()
          conv.buffer = reverbImpulse(this.ctx)
          // la coda normalizzata è piano: la si alza perché il "lavaggio" si senta
          const boost = this.ctx.createGain()
          boost.gain.value = 2.5
          input.connect(conv)
          conv.connect(boost)
          boost.connect(output)
          return [conv, boost]
        }, t0 + plan.bIn * k, end)
        send.setValueAtTime(0, now)
        send.setValueAtTime(0, t0 - plan.barSeconds * k)
        send.linearRampToValueAtTime(1.2, t0)
        send.setValueAtTime(1.2, t0 + beat / 2)
        send.linearRampToValueAtTime(0, t0 + beat)
        g.setValueAtTime(this.level, t0)
        g.linearRampToValueAtTime(0, t0 + beat / 2)
        break
      }
      case 'roll': {
        if (!buf) break
        // loop del primo battito che si accorcia: 1, 1/2, 1/4, 1/8 di battito
        const b = plan.barSeconds / 4
        let t = t0
        for (const [len, beats] of [
          [1, 4],
          [1 / 2, 2],
          [1 / 4, 1],
          [1 / 8, 1]
        ]) {
          const stop = t + beats * beat
          this.playBuffer(buf, rateA, t, plan.aStart, stop, { start: plan.aStart, end: plan.aStart + len * b })
          t = stop
        }
        this.muteMediaAt(t0)
        const h = this.hp.frequency
        h.setValueAtTime(0, now)
        h.setValueAtTime(30, t0)
        h.exponentialRampToValueAtTime(1500, t)
        cutAt(t)
        break
      }
      case 'brake': {
        if (!buf) break
        const src = this.playBuffer(buf, rateA, t0, plan.aStart, end + 0.1)
        const stopAt = t0 + 2 * beat
        src.playbackRate.setValueAtTime(rateA, t0)
        src.playbackRate.linearRampToValueAtTime(0.02, stopAt)
        this.muteMediaAt(t0)
        g.setValueAtTime(this.level, stopAt - beat / 2)
        g.linearRampToValueAtTime(0, stopAt)
        break
      }
      case 'spinback': {
        if (!buf) break
        // gli ultimi secondi prima del punto, al contrario: il disco gira all'indietro, veloce e poi si ferma
        const sr = buf.sampleRate
        const endIdx = Math.min(buf.length, Math.floor(plan.aStart * sr))
        const startIdx = Math.max(0, endIdx - Math.floor(8 * sr))
        const len = endIdx - startIdx
        if (len < sr / 2) {
          cutAt(t0)
          break
        }
        const rev = this.ctx.createBuffer(buf.numberOfChannels, len, sr)
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const src = buf.getChannelData(c)
          const dst = rev.getChannelData(c)
          for (let i = 0; i < len; i++) dst[i] = src[endIdx - 1 - i]
        }
        const src = this.playBuffer(rev, 0.3, t0, 0, t0 + SPINBACK_SECONDS + 0.1)
        src.playbackRate.setValueAtTime(0.3, t0)
        src.playbackRate.linearRampToValueAtTime(3, t0 + 0.15)
        src.playbackRate.exponentialRampToValueAtTime(0.1, t0 + SPINBACK_SECONDS)
        this.muteMediaAt(t0)
        g.setValueAtTime(this.level, t0 + SPINBACK_SECONDS * 0.6)
        g.linearRampToValueAtTime(0, t0 + SPINBACK_SECONDS)
        break
      }
    }
    this.timers.push(setTimeout(() => this.finish(), msUntil(this.ctx, end) + 30))
  }

  /** Suona un pezzo del brano dalla memoria (dentro i bassi e i filtri del brano), da `when` a `until`. */
  private playBuffer(
    buf: AudioBuffer,
    rate: number,
    when: number,
    offset: number,
    until: number,
    loop?: { start: number; end: number }
  ): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    if (loop) {
      src.loop = true
      src.loopStart = loop.start
      src.loopEnd = loop.end
    }
    src.playbackRate.value = rate
    const lg = this.ctx.createGain()
    lg.gain.setValueAtTime(0, this.ctx.currentTime)
    lg.gain.setValueAtTime(0, when - 0.004)
    lg.gain.linearRampToValueAtTime(1, when + 0.004)
    lg.gain.setValueAtTime(1, until - 0.006)
    lg.gain.linearRampToValueAtTime(0, until)
    src.connect(lg)
    lg.connect(this.bass)
    src.start(when - 0.004, Math.max(0, offset - 0.004 * rate))
    src.stop(until + 0.01)
    this.bufSources.push(src)
    this.fx.push(lg)
    return src
  }

  /** Dall'istante `t` il file non si sente più (suona la memoria al suo posto). */
  private muteMediaAt(t: number): void {
    const m = this.mediaGain.gain
    m.setValueAtTime(1, t - 0.004)
    m.linearRampToValueAtTime(0, t + 0.004)
    this.timers.push(setTimeout(() => this.audio.pause(), msUntil(this.ctx, t) + 50))
  }

  /**
   * Collega un effetto (eco, riverbero) dopo i filtri del brano. Restituisce il volume della mandata; il ritorno
   * sfuma da `fadeFrom` a `fadeTo` (la coda continua anche quando il brano è già a volume zero).
   */
  private effect(build: (input: AudioNode, output: AudioNode) => AudioNode[], fadeFrom: number, fadeTo: number): AudioParam {
    const send = this.ctx.createGain()
    send.gain.value = 0
    const ret = this.ctx.createGain()
    ret.gain.value = this.level
    const nodes = build(send, ret)
    this.hp.connect(send)
    ret.connect(this.destination)
    ret.gain.setValueAtTime(this.level, fadeFrom)
    ret.gain.linearRampToValueAtTime(0, fadeTo)
    this.fx.push(send, ret, ...nodes)
    return send.gain
  }

  /** Annulla un Mix DJ preparato con mixOut (il brano che entra non è partito). */
  cancelMix(): void {
    if (this.done) return
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>)
    this.timers = []
    this.dropEffects()
    const now = this.ctx.currentTime
    for (const [p, v] of [
      [this.gain.gain, this.level],
      [this.bass.gain, 0],
      [this.mediaGain.gain, 1],
      [this.lp.frequency, this.ctx.sampleRate / 2],
      [this.hp.frequency, 0]
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

  /** Ferma i pezzi suonati dalla memoria e stacca gli effetti. */
  private dropEffects(): void {
    for (const src of this.bufSources) {
      try {
        src.stop()
      } catch {
        // già fermo
      }
      src.disconnect()
    }
    this.bufSources = []
    for (const n of this.fx) n.disconnect()
    this.fx = []
  }

  private release(): void {
    this.done = true
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>)
    this.timers = []
    this.dropEffects()
    this.audio.pause()
    this.source?.disconnect()
    this.mediaGain.disconnect()
    this.bass.disconnect()
    this.lp.disconnect()
    this.hp.disconnect()
    this.gain.disconnect()
    this.audio.removeAttribute('src')
    this.audio.load()
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * Ritardo (secondi) del segnale `live` rispetto a `ref` (live(t) ≈ ref(t - ritardo)), cercato tra ±`range`.
 * `ref` comincia con del silenzio (parte dopo): si guarda solo dove suona. Prima un confronto grossolano su un
 * segnale ridotto, poi preciso al campione. Tra due somiglianze quasi uguali (battiti tutti uguali) vince il
 * ritardo più piccolo. null se i due segnali non si somigliano abbastanza.
 */
export function findLag(live: Float32Array, ref: Float32Array, sr: number, seconds: number, range: number): number | null {
  let s0 = 0
  while (s0 < ref.length && Math.abs(ref[s0]) < 1e-6) s0++
  const R = Math.floor(range * sr)
  const W = Math.floor(seconds * sr)
  const w0 = s0 + R + Math.floor(0.05 * sr)
  if (w0 + W + R > ref.length || w0 + W > live.length) return null
  const D = 8
  const dec = (x: Float32Array): Float32Array => {
    const out = new Float32Array(Math.floor(x.length / D))
    for (let i = 0; i < out.length; i++) {
      let acc = 0
      for (let k = 0; k < D; k++) acc += x[i * D + k]
      out[i] = acc / D
    }
    return out
  }
  const ncc = (x: Float32Array, y: Float32Array, start: number, len: number, lag: number): number => {
    let xy = 0
    let xx = 0
    let yy = 0
    for (let i = start; i < start + len; i++) {
      const u = x[i]
      const v = y[i - lag]
      xy += u * v
      xx += u * u
      yy += v * v
    }
    return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0
  }
  const xl = dec(live)
  const yr = dec(ref)
  const cs = Math.floor(w0 / D)
  const cl = Math.floor(W / D)
  const cr = Math.floor(R / D)
  const scores: number[] = []
  for (let l = -cr; l <= cr; l++) scores.push(ncc(xl, yr, cs, cl, l))
  const best = Math.max(...scores)
  if (!(best > 0.5)) return null
  // il picco più vicino a zero tra quelli quasi alti come il migliore
  let pick = 0
  for (let i = 1; i < scores.length - 1; i++) {
    const isPeak = scores[i] >= scores[i - 1] && scores[i] >= scores[i + 1]
    if (isPeak && scores[i] >= best * 0.97 && Math.abs(i - cr) < Math.abs(pick - cr)) pick = i
  }
  if (scores[pick] < best * 0.97) pick = scores.indexOf(best)
  const coarse = (pick - cr) * D
  let fine = coarse
  let fineScore = -Infinity
  const at = new Map<number, number>()
  for (let l = coarse - 2 * D; l <= coarse + 2 * D; l++) {
    if (Math.abs(l) > R) continue
    const v = ncc(live, ref, w0, W, l)
    at.set(l, v)
    if (v > fineScore) {
      fineScore = v
      fine = l
    }
  }
  if (!(fineScore > 0.5)) return null
  // tra due campioni: vertice della parabola
  const ym = at.get(fine - 1)
  const yp = at.get(fine + 1)
  let frac = 0
  if (ym !== undefined && yp !== undefined) {
    const den = ym - 2 * fineScore + yp
    if (den < 0) frac = (0.5 * (ym - yp)) / den
  }
  return (fine + frac) / sr
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
