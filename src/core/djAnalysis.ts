/**
 * Analisi "da DJ" di un brano: BPM e griglia dei battiti, primo tempo di battuta, tonalità,
 * energia, fine dell'intro e inizio dell'outro. Serve al Mix DJ (cambi sul battito) e, in futuro,
 * alla rotazione per energia.
 *
 * Il calcolo dei battiti, della tonalità e della "ballabilità" lo fa Essentia (essentia.js, AGPL);
 * qui sopra ci sono solo regole semplici e verificabili con le prove.
 */

export interface DjAnalysis {
  /** Battiti al minuto. 0 = griglia non affidabile (il brano non si mixa sul battito). */
  bpm: number
  /** Secondi: primo battito "uno" della battuta dopo l'inizio dell'audio. */
  firstDownbeat: number
  /** 0..1: quanto i battiti trovati seguono una griglia regolare. */
  gridConfidence: number
  /** Tonalità in notazione Camelot (es. "8A" = La minore). '' = sconosciuta. */
  key: string
  /** Energia stimata da 1 (calmo) a 10 (molto energico). 0 = sconosciuta. */
  energy: number
  /** Secondi: dove finisce l'intro (uguale a firstDownbeat se il brano parte subito pieno). */
  introEnd: number
  /** Secondi: dove inizia l'outro (uguale alla fine se il brano finisce pieno). */
  outroStart: number
  /**
   * Secondi di ogni "uno" di battuta, seguiti battuta per battuta: i brani suonati senza metronomo accelerano o
   * rallentano un poco e una griglia fissa, giusta a metà brano, sbaglia di decine di millesimi all'inizio e alla fine.
   * Assente nelle analisi fatte prima di questa versione (allora vale la griglia fissa).
   */
  downbeats?: number[]
}

/**
 * Versione dell'analisi DJ: i brani analizzati con una versione precedente vengono rianalizzati in background.
 * 3: con la 2 nella regia installata il thread di analisi non partiva (file mancante) e ogni brano risultava
 * "senza ritmo regolare": si rifà tutto.
 */
export const DJ_ANALYSIS_VERSION = 3

/** Sotto questa affidabilità della griglia il brano non si mixa sul battito. */
export const MIN_GRID_CONFIDENCE = 0.6
/** Battute di una frase musicale (pop e dance ragionano a gruppi di 8). */
export const PHRASE_BARS = 8
/** Una battuta "piena" ha almeno questa frazione dell'energia tipica del brano. */
const FULL_ENERGY = 0.75
/** Intro e outro più lunghe di così sono quasi sempre un errore (brano tutto calmo o tutto pieno). */
const MAX_SECTION_SECONDS = 90

export interface Grid {
  bpm: number
  /** Secondi del primo battito della griglia (dopo `from`). */
  firstBeat: number
  confidence: number
}

/**
 * Adatta una griglia a passo costante ai battiti trovati (tra `from` e `to`).
 * La musica registrata con il metronomo ha il passo costante: la griglia è precisa per tutto il brano.
 */
export function fitGrid(ticks: number[], from: number, to: number): Grid {
  const t = ticks.filter((x) => x >= from && x <= to)
  if (t.length < 16) return { bpm: 0, firstBeat: from, confidence: 0 }
  const intervals: number[] = []
  for (let i = 1; i < t.length; i++) intervals.push(t[i] - t[i - 1])
  let period = median(intervals)
  if (!(period > 0.2 && period < 2)) return { bpm: 0, firstBeat: from, confidence: 0 }
  // regressione tempo = fase + indice * periodo, allargata a poco a poco: con il periodo
  // approssimato l'errore si accumula, quindi lo si affina prima su pochi battiti e poi su tutti
  for (let n = Math.min(32, t.length); ; n = Math.min(t.length, n * 2)) {
    const idx = t.slice(0, n).map((x) => Math.round((x - t[0]) / period))
    const mi = idx.reduce((a, b) => a + b, 0) / n
    const mt = t.slice(0, n).reduce((a, b) => a + b, 0) / n
    let num = 0
    let den = 0
    for (let i = 0; i < n; i++) {
      num += (idx[i] - mi) * (t[i] - mt)
      den += (idx[i] - mi) ** 2
    }
    if (den > 0 && num > 0) period = num / den
    if (n >= t.length) break
  }
  // fase: mediana degli scarti rispetto alla griglia
  const offsets = t.map((x) => {
    const r = (x - t[0]) % period
    return r > period / 2 ? r - period : r
  })
  const phase = t[0] + median(offsets)
  const tol = Math.min(0.05, period * 0.1)
  let ok = 0
  for (const x of t) {
    const k = Math.round((x - phase) / period)
    if (Math.abs(x - (phase + k * period)) <= tol) ok++
  }
  let firstBeat = phase
  while (firstBeat - period >= from - 1e-6) firstBeat -= period
  while (firstBeat < from - 1e-6) firstBeat += period
  return { bpm: round(60 / period, 2), firstBeat: round(firstBeat, 3), confidence: round(ok / t.length, 3) }
}

/** Battiti seguiti uno a uno: i tempi (secondi) e quanti dei battiti trovati da Essentia ci cadono sopra. */
export interface BeatTrack {
  beats: number[]
  confidence: number
}

/** Mezza larghezza (in battiti) della finestra con cui si stima il tempo locale. */
const LOCAL_BEATS = 12
/** Distanza massima (secondi) di un battito trovato dalla griglia per contarlo "sul battito". */
const ON_BEAT = 0.035
/** Secondi iniziali in cui i battiti trovati da Essentia non sono affidabili. */
const WARMUP_SECONDS = 3

/**
 * Segue i battiti partendo dalla griglia fissa: a ogni battito prevede il successivo, lo aggancia al battito trovato
 * più vicino e adatta piano piano il passo (come l'orecchio di un DJ). Poi ogni battito viene rimesso sulla retta che
 * passa meglio per i battiti vicini (±12): così il tempo locale segue le accelerazioni, ma un battito trovato male
 * non sposta la griglia.
 */
export function trackBeats(ticks: number[], grid: Grid, from: number, to: number): BeatTrack {
  // i primi battiti di Essentia sono di "riscaldamento" e spesso sbagliati di decine di millesimi
  const t = ticks.filter((x) => x >= Math.max(from - 0.1, WARMUP_SECONDS) && x <= to + 0.1).sort((a, b) => a - b)
  if (!(grid.bpm > 0) || t.length < 16) return { beats: [], confidence: 0 }
  const p0 = 60 / grid.bpm
  const nearest = (x: number): number | null => {
    let lo = 0
    let hi = t.length - 1
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (t[m] < x) lo = m + 1
      else hi = m
    }
    let best = t[lo]
    if (lo > 0 && Math.abs(t[lo - 1] - x) < Math.abs(best - x)) best = t[lo - 1]
    return best
  }
  // 1. aggancio battito per battito, dal centro del brano (dove la griglia fissa è più giusta) verso i due capi
  const mid = t[t.length >> 1]
  const startBeat = grid.firstBeat + Math.round((mid - grid.firstBeat) / p0) * p0
  const walk = (dir: 1 | -1): { b: number; hit: number | null }[] => {
    const out: { b: number; hit: number | null }[] = []
    let p = p0
    let b = startBeat
    for (let i = 0; i < 4000; i++) {
      if (dir > 0 ? b > to + 1e-6 : b < from - 1e-6) break
      const x = nearest(b)
      let hit: number | null = null
      if (x !== null && Math.abs(x - b) <= 0.15 * p) {
        const e = x - b
        hit = x
        b += 0.4 * e
        p = Math.min(p0 * 1.08, Math.max(p0 / 1.08, p + 0.05 * e * dir))
      }
      out.push({ b, hit })
      b += dir * p
    }
    return out
  }
  const fwd = walk(1)
  const back = walk(-1).slice(1).reverse()
  const all = [...back, ...fwd]
  const pll = all.map((x) => x.b)
  const matched: { i: number; t: number }[] = []
  all.forEach((x, i) => {
    if (x.hit !== null) matched.push({ i, t: x.hit })
  })
  if (matched.length < 16) return { beats: [], confidence: 0 }
  // 2. retta locale (pesata, senza i battiti trovati troppo lontani) per ogni battito
  const beats = pll.map((guess, i) => {
    let lo = 0
    let hi = matched.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (matched[m].i < i - LOCAL_BEATS) lo = m + 1
      else hi = m
    }
    const near: { i: number; t: number }[] = []
    for (let k = lo; k < matched.length && matched[k].i <= i + LOCAL_BEATS; k++) near.push(matched[k])
    if (near.length < 6) return guess
    let fit = lineFit(near, i, null)
    for (let pass = 0; fit && pass < 3; pass++) fit = lineFit(near, i, fit) ?? fit
    return fit ? fit.at(i) : guess
  })
  // affidabilità: battiti trovati che cadono sulla griglia seguita
  const tol = Math.min(ON_BEAT, p0 * 0.08)
  let ok = 0
  let n = 0
  let k = 0
  for (const x of t) {
    if (x < from || x > to) continue
    n++
    while (k + 1 < beats.length && beats[k + 1] <= x) k++
    const d = Math.min(Math.abs(x - beats[k]), k + 1 < beats.length ? Math.abs(beats[k + 1] - x) : Infinity)
    if (d <= tol) ok++
  }
  const first = beats.findIndex((x) => x >= from - 1e-6)
  return { beats: beats.slice(Math.max(0, first)).filter((x) => x <= to).map((x) => round(x, 4)), confidence: n ? round(ok / n, 3) : 0 }
}

/** Retta tempo = a + b * indice sui battiti vicini, pesati per distanza; con `prev` scarta quelli lontani dalla retta. */
function lineFit(
  pts: { i: number; t: number }[],
  center: number,
  prev: { at: (i: number) => number } | null
): { at: (i: number) => number } | null {
  let sw = 0
  let si = 0
  let st = 0
  for (const q of pts) {
    if (prev && Math.abs(q.t - prev.at(q.i)) > ON_BEAT) continue
    const w = 1 - Math.abs(q.i - center) / (LOCAL_BEATS + 1)
    sw += w
    si += w * q.i
    st += w * q.t
  }
  if (sw <= 0) return null
  const mi = si / sw
  const mt = st / sw
  let num = 0
  let den = 0
  for (const q of pts) {
    if (prev && Math.abs(q.t - prev.at(q.i)) > ON_BEAT) continue
    const w = 1 - Math.abs(q.i - center) / (LOCAL_BEATS + 1)
    num += w * (q.i - mi) * (q.t - mt)
    den += w * (q.i - mi) ** 2
  }
  if (!(den > 0) || !(num > 0)) return null
  const slope = num / den
  return { at: (i: number) => mt + (i - mi) * slope }
}

/**
 * Sceglie quale dei 4 battiti è l'"uno" della battuta: è dove cambiano gli accordi
 * (novità armonica) e, a parità, dove i bassi sono più forti.
 * `novelty[i]` e `bass[i]` si riferiscono al battito i della griglia.
 */
export function chooseDownbeat(novelty: number[], bass: number[]): number {
  const n = Math.min(novelty.length, bass.length)
  if (n < 8) return 0
  const nz = normalize(novelty.slice(0, n))
  const bz = normalize(bass.slice(0, n))
  let best = 0
  let bestScore = -Infinity
  for (let p = 0; p < 4; p++) {
    let s = 0
    let c = 0
    for (let i = p; i < n; i += 4) {
      s += nz[i] + 0.5 * bz[i]
      c++
    }
    const score = c ? s / c : 0
    if (score > bestScore + 1e-9) {
      bestScore = score
      best = p
    }
  }
  return best
}

/**
 * Trova fine dell'intro e inizio dell'outro dall'energia di ogni battuta.
 * L'intro finisce alla prima frase (8 battute dal primo "uno") da cui il brano resta pieno;
 * l'outro inizia all'ultima frase dopo la quale il brano non è più pieno.
 * Se il brano non si può dividere in frasi i punti cadono su battute qualsiasi.
 */
export function findSections(
  barEnergy: number[],
  firstDownbeat: number,
  barSeconds: number,
  end: number,
  /** Inizio di ogni battuta seguita (se c'è vale questa al posto della griglia fissa). */
  barTimes?: number[]
): { introEnd: number; outroStart: number } {
  const bars = barEnergy.length
  if (!bars || !(barSeconds > 0)) return { introEnd: firstDownbeat, outroStart: end }
  const typical = percentile(barEnergy, 0.6)
  const full = barEnergy.map((e) => e >= typical * FULL_ENERGY)
  // prima battuta da cui almeno 3 delle 4 successive sono piene
  const fullFrom = (i: number): boolean => {
    let c = 0
    let n = 0
    for (let j = i; j < Math.min(bars, i + 4); j++, n++) if (full[j]) c++
    return n > 0 && c >= Math.ceil(n * 0.75)
  }
  let introBar = 0
  while (introBar < bars && !fullFrom(introBar)) introBar++
  if (introBar >= bars) introBar = 0
  // ultima battuta piena prima della coda
  let lastFull = bars - 1
  while (lastFull > 0 && !(full[lastFull] && fullFrom(Math.max(0, lastFull - 3)))) lastFull--
  let outroBar = lastFull + 1
  // allineamento alle frasi: l'intro si arrotonda alla frase più vicina, l'outro anche
  const snap = (b: number): number => {
    const p = Math.round(b / PHRASE_BARS) * PHRASE_BARS
    return Math.abs(p - b) <= 2 ? p : b
  }
  introBar = Math.min(snap(introBar), bars)
  outroBar = Math.max(introBar, Math.min(snap(outroBar), bars))
  const at = (i: number): number => barTimes?.[i] ?? firstDownbeat + i * barSeconds
  let introEnd = at(introBar)
  let outroStart = at(outroBar)
  if (introEnd - firstDownbeat > MAX_SECTION_SECONDS) introEnd = firstDownbeat
  if (end - outroStart > MAX_SECTION_SECONDS) outroStart = end
  return { introEnd: round(Math.min(introEnd, end), 3), outroStart: round(Math.min(outroStart, end), 3) }
}

const CAMELOT_MAJOR: Record<string, number> = { B: 1, 'F#': 2, Gb: 2, Db: 3, 'C#': 3, Ab: 4, 'G#': 4, Eb: 5, 'D#': 5, Bb: 6, 'A#': 6, F: 7, C: 8, G: 9, D: 10, A: 11, E: 12 }
const CAMELOT_MINOR: Record<string, number> = { 'G#': 1, Ab: 1, 'D#': 2, Eb: 2, 'A#': 3, Bb: 3, F: 4, C: 5, G: 6, D: 7, A: 8, E: 9, B: 10, 'F#': 11, Gb: 11, 'C#': 12, Db: 12 }

/** Tonalità di Essentia ("A", "minor") in notazione Camelot ("8A"). */
export function camelot(key: string, scale: string): string {
  const minor = scale.toLowerCase().startsWith('min')
  const n = (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[key]
  return n ? `${n}${minor ? 'A' : 'B'}` : ''
}

/** Due tonalità stanno bene insieme se uguali, vicine sulla ruota o relative maggiore/minore. */
export function keysCompatible(a: string, b: string): boolean {
  const pa = /^(\d+)([AB])$/.exec(a)
  const pb = /^(\d+)([AB])$/.exec(b)
  if (!pa || !pb) return true
  const na = Number(pa[1])
  const nb = Number(pb[1])
  const d = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12)
  if (pa[2] === pb[2]) return d <= 1
  return d === 0
}

/**
 * Energia da 1 a 10: ballabilità (Essentia, circa 0..3), velocità e quanto il brano è "pieno"
 * (densità di battute piene). È una stima, utile per confrontare i brani tra loro.
 */
export function energyScore(danceability: number, bpm: number, fullBarsRatio: number): number {
  const d = clamp01((danceability - 0.6) / 1.8)
  const b = bpm > 0 ? clamp01((foldBpm(bpm) - 70) / 80) : 0.4
  const f = clamp01(fullBarsRatio)
  return Math.max(1, Math.min(10, Math.round(1 + 9 * (0.55 * d + 0.25 * b + 0.2 * f))))
}

/** Riporta i BPM tra 70 e 140 (un brano a 160 si "sente" anche a 80 e viceversa). */
export function foldBpm(bpm: number): number {
  let b = bpm
  if (!(b > 0)) return 0
  while (b < 70) b *= 2
  while (b > 140) b /= 2
  return b
}

// ---------- calcolo sull'audio ----------

/** Le funzioni di essentia.js usate qui (il resto della libreria non serve). */
export interface EssentiaLike {
  arrayToVector(a: Float32Array): unknown
  vectorToArray(v: unknown): Float32Array
  RhythmExtractor2013(signal: unknown, maxTempo?: number, method?: string, minTempo?: number): { ticks: unknown; bpm: number }
  KeyExtractor(signal: unknown): { key: string; scale: string; strength: number }
  Danceability(signal: unknown): { danceability: number }
  Windowing(frame: unknown, normalized?: boolean, size?: number, type?: string): { frame: unknown }
  Spectrum(frame: unknown, size?: number): { spectrum: unknown }
  SpectralPeaks(spectrum: unknown, magnitudeThreshold?: number, maxFrequency?: number, maxPeaks?: number, minFrequency?: number, orderBy?: string, sampleRate?: number): { frequencies: unknown; magnitudes: unknown }
  HPCP(frequencies: unknown, magnitudes: unknown): { hpcp: unknown }
}

const CHROMA_FRAME = 4096
const CHROMA_HOP = 4096

/**
 * Analizza l'audio (mono, float, `sampleRate` Hz) tra `cueIn` e `cueOut`.
 * Circa 2-3 secondi per un brano di 4 minuti.
 */
export function analyzeDjSignal(e: EssentiaLike, signal: Float32Array, sampleRate: number, cueIn: number, cueOut: number): DjAnalysis {
  const duration = signal.length / sampleRate
  const end = cueOut > cueIn ? Math.min(cueOut, duration) : duration
  const start = Math.max(0, Math.min(cueIn, end))
  const vec = e.arrayToVector(signal)
  freeLater(vec)
  const rhythm = e.RhythmExtractor2013(vec, 208, 'degara', 40)
  const ticks = Array.from(e.vectorToArray(rhythm.ticks))
  freeLater(rhythm.ticks)
  const key = e.KeyExtractor(vec)
  const dance = e.Danceability(vec).danceability

  const grid = fitGrid(ticks, start, end)
  // a volte i battiti trovati cadono sui controtempi (charleston): la cassa sta sul battito vero
  if (grid.bpm > 0) {
    const half = 30 / grid.bpm
    const on = sampleBeats(grid.firstBeat, 60 / grid.bpm, end)
    const off = sampleBeats(grid.firstBeat + half, 60 / grid.bpm, end)
    const bOn = mean(beatBass(signal, sampleRate, on, 60 / grid.bpm))
    const bOff = mean(beatBass(signal, sampleRate, off, 60 / grid.bpm))
    if (bOff > bOn * 1.25) {
      const shifted = grid.firstBeat + half
      grid.firstBeat = round(shifted - 2 * half >= start ? shifted - 2 * half : shifted, 3)
    }
  }
  // battiti seguiti uno a uno: la griglia fissa va bene solo per i brani fatti con il metronomo
  const tracked = trackBeats(ticks, grid, start, end)
  const follow = tracked.beats.length >= 16 && tracked.confidence >= grid.confidence - 0.05
  const confidence = follow ? tracked.confidence : grid.confidence
  const usable = grid.bpm > 0 && confidence >= MIN_GRID_CONFIDENCE
  const beatSec = grid.bpm > 0 ? 60 / grid.bpm : 0.5
  const beatTimes = follow ? tracked.beats.filter((t) => t < end) : sampleBeats(grid.firstBeat, beatSec, end)

  // per ogni battito: novità armonica (cambio di accordo) e forza dei bassi
  const chroma = beatChroma(e, signal, sampleRate, beatTimes)
  const novelty = chroma.map((c, i) => (i === 0 ? 0 : 1 - cosine(c, chroma[i - 1])))
  const bass = beatBass(signal, sampleRate, beatTimes, beatSec)
  const phase = usable ? chooseDownbeat(novelty, bass) : 0
  const firstDownbeat = beatTimes[phase] ?? start
  const downbeats: number[] = []
  for (let i = phase; i < beatTimes.length; i += 4) downbeats.push(round(beatTimes[i], 3))

  const barSec = beatSec * 4
  const barEnergy: number[] = []
  if (follow) {
    for (let i = 0; i + 1 < downbeats.length && downbeats[i + 1] <= end + 0.01; i++) barEnergy.push(rms(signal, sampleRate, downbeats[i], downbeats[i + 1]))
  } else {
    for (let t = firstDownbeat; t + barSec <= end + 0.01; t += barSec) barEnergy.push(rms(signal, sampleRate, t, t + barSec))
  }
  const sections = findSections(barEnergy, firstDownbeat, barSec, end, follow ? downbeats : undefined)
  const typical = percentile(barEnergy, 0.6)
  const fullRatio = barEnergy.length ? barEnergy.filter((x) => x >= typical * FULL_ENERGY).length / barEnergy.length : 0

  freeAll()
  return {
    bpm: usable ? grid.bpm : 0,
    firstDownbeat: round(firstDownbeat, 3),
    gridConfidence: confidence,
    key: key.strength > 0.3 ? camelot(key.key, key.scale) : '',
    energy: energyScore(dance, grid.bpm, fullRatio),
    introEnd: usable ? sections.introEnd : round(start, 3),
    outroStart: usable ? sections.outroStart : round(end, 3),
    ...(usable && follow ? { downbeats } : {})
  }
}

function beatChroma(e: EssentiaLike, signal: Float32Array, sr: number, beats: number[]): number[][] {
  const out = beats.map(() => new Array<number>(12).fill(0))
  if (!beats.length) return out
  let b = 0
  // fotogrammi tagliati qui: il FrameGenerator di essentia.js salta i tratti silenziosi e sfasa i tempi
  for (let start = Math.max(0, Math.floor(beats[0] * sr)); start + CHROMA_FRAME <= signal.length; start += CHROMA_HOP) {
    const t = (start + CHROMA_FRAME / 2) / sr
    if (t < beats[0]) continue
    while (b + 1 < beats.length && beats[b + 1] <= t) b++
    if (b === beats.length - 1 && t > beats[b] + (beats.length > 1 ? beats[b] - beats[b - 1] : 0.5)) break
    const frame = e.arrayToVector(signal.subarray(start, start + CHROMA_FRAME))
    const w = e.Windowing(frame, true, CHROMA_FRAME, 'blackmanharris62').frame
    const s = e.Spectrum(w, CHROMA_FRAME).spectrum
    const p = e.SpectralPeaks(s, 0.0001, 5000, 60, 40, 'magnitude', sr)
    const hv = e.HPCP(p.frequencies, p.magnitudes).hpcp
    const h = e.vectorToArray(hv)
    for (let k = 0; k < 12 && k < h.length; k++) out[b][k] += h[k]
    for (const v of [frame, w, s, p.frequencies, p.magnitudes, hv]) free(v)
  }
  return out
}

/** Energia sotto i 150 Hz intorno a ogni battito (filtro passa-basso semplice). */
function beatBass(signal: Float32Array, sr: number, beats: number[], beatSec: number): number[] {
  const a = Math.exp((-2 * Math.PI * 150) / sr)
  return beats.map((t) => {
    const s0 = Math.max(0, Math.floor(t * sr))
    const s1 = Math.min(signal.length, Math.floor((t + Math.min(0.12, beatSec / 2)) * sr))
    let y = 0
    let acc = 0
    for (let i = s0; i < s1; i++) {
      y = (1 - a) * signal[i] + a * y
      acc += y * y
    }
    return s1 > s0 ? Math.sqrt(acc / (s1 - s0)) : 0
  })
}

function sampleBeats(first: number, beatSec: number, end: number): number[] {
  const out: number[] = []
  for (let i = 0; first + i * beatSec < end; i++) out.push(first + i * beatSec)
  return out
}

function mean(x: number[]): number {
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0
}

function rms(signal: Float32Array, sr: number, t0: number, t1: number): number {
  const s0 = Math.max(0, Math.floor(t0 * sr))
  const s1 = Math.min(signal.length, Math.floor(t1 * sr))
  let acc = 0
  for (let i = s0; i < s1; i++) acc += signal[i] * signal[i]
  return s1 > s0 ? Math.sqrt(acc / (s1 - s0)) : 0
}

// gli oggetti di essentia.js vivono nella memoria WebAssembly e vanno liberati a mano
const pending: unknown[] = []
function freeLater(v: unknown): void {
  pending.push(v)
}
function free(v: unknown): void {
  const d = (v as { delete?: () => void } | null)?.delete
  if (typeof d === 'function') {
    try {
      d.call(v)
    } catch {
      // già liberato
    }
  }
}
function freeAll(): void {
  while (pending.length) free(pending.pop())
}

function cosine(a: number[], b: number[]): number {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 1
}

function normalize(x: number[]): number[] {
  const m = x.reduce((a, b) => a + b, 0) / x.length
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length)
  return x.map((v) => (sd > 0 ? (v - m) / sd : 0))
}

function median(x: number[]): number {
  return percentile(x, 0.5)
}

function percentile(x: number[], p: number): number {
  if (!x.length) return 0
  const s = [...x].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))]
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function round(n: number, d: number): number {
  const k = 10 ** d
  return Math.round(n * k) / k
}
