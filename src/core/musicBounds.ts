/**
 * Dove comincia e dove finisce davvero la musica in un brano: prima e dopo ci possono essere silenzio, applausi,
 * rumore, una presentazione parlata o una "traccia fantasma" dopo minuti di silenzio. Il file non si tocca: si
 * spostano solo i punti di inizio e di fine (richiesta di cristian del 27/11/2026: "taglia automaticamente tutte le
 * cose che non sono musica prima e dopo le tracce").
 *
 * Come funziona, secondo per secondo:
 * - silenzio: molto più basso del corpo del brano;
 * - rumore (applausi, pubblico, fruscio): spettro "piatto", tutte le frequenze insieme;
 * - parlato: la voce parlata ha tante piccole pause tra le sillabe (molti istanti quasi muti dentro ogni secondo),
 *   la musica invece riempie il tempo.
 * Ogni secondo si confronta con il corpo del brano (la sua parte centrale): un brano che è tutto voce e chitarra o
 * tutto a cappella non viene scambiato per parlato, perché è fatto così dall'inizio alla fine.
 * Si taglia solo all'inizio o alla fine, e solo se dopo (o prima) c'è musica vera per qualche secondo di fila; i
 * tagli più lunghi di un limite non si fanno (meglio lasciare un'intro strana che tagliare una canzone).
 */

/** Campionamento usato per questa analisi (basta per voce, applausi e silenzi; il file si legge una volta sola). */
export const BOUNDS_SAMPLE_RATE = 11025
/**
 * Versione del calcolo: i brani analizzati con una versione precedente si rianalizzano in background.
 * 1 = solo silenzio (prima del 27/11/2026); 2 = anche applausi, rumore, parlato e tracce fantasma.
 */
export const CUE_ANALYSIS_VERSION = 2

/** Secondi di musica di fila che servono per dire "qui comincia (o finisce) la musica". */
const MUSIC_RUN = 5
/** Taglio massimo all'inizio per parti non musicali (il silenzio puro si taglia sempre). */
export const MAX_CUT_START = 45
/** Taglio massimo alla fine per parti non musicali (applausi lunghi dei live, saluti, ringraziamenti). */
export const MAX_CUT_END = 90
/** Silenzio interno da cui ciò che segue è una traccia fantasma (si taglia sempre). */
const HIDDEN_GAP_LONG = 10
/** Silenzio interno da cui ciò che segue è una traccia fantasma se è corto o non è musica. */
const HIDDEN_GAP_SHORT = 4
/** Prima di una traccia fantasma ci deve essere almeno questa musica (altrimenti è il brano che comincia tardi). */
const HIDDEN_MIN_BEFORE = 90

/** Sotto questi dB rispetto al corpo del brano un secondo è silenzio. */
const SILENCE_BELOW_BODY_DB = 35
/** Sotto questo livello assoluto (dBFS) un secondo è silenzio comunque. */
const SILENCE_DBFS = -55
/** Piattezza dello spettro da cui un secondo è rumore (la musica sta di solito sotto 0,15). */
const NOISE_FLATNESS = 0.3
/** Quota di istanti "quasi muti" da cui un secondo è parlato. */
const SPEECH_LOW_ENERGY = 0.3
/** Di quanto il parlato deve superare il corpo del brano in istanti "quasi muti". */
const SPEECH_OVER_BODY = 0.15
/** Sotto questa somiglianza tra un quarto di secondo e l'altro il suono "cambia di continuo" come la voce parlata. */
const SPEECH_STABILITY = 0.6
/** Sotto questa regolarità il suono non va a tempo. */
const SPEECH_RHYTHM = 0.55

export type BlockKind = 'music' | 'silence' | 'noise' | 'speech'

export interface BlockFeatures {
  /** dBFS del secondo */
  db: number
  /** 0..1 piattezza dello spettro (1 = rumore bianco) */
  flatness: number
  /** 0..1 quota di istanti da 20 ms sotto metà del volume medio del secondo */
  lowEnergy: number
  /** 0..1 quanto lo spettro resta simile da un quarto di secondo all'altro (note tenute, accordi) */
  stability: number
  /** 0..1 quanto il volume si ripete a passo regolare nei secondi intorno (battito, colpi a tempo) */
  rhythm: number
}

export interface MusicBounds {
  /** Secondi: inizio della musica. */
  start: number
  /** Secondi: fine della musica. */
  end: number
  /** Cosa è stato tagliato all'inizio e alla fine (per i messaggi e le prove). */
  cutStart: BlockKind | null
  cutEnd: BlockKind | 'hidden' | null
}

const FFT_SIZE = 1024
const FFTS_PER_BLOCK = 4

/** Misure di ogni secondo del segnale (mono, `sr` Hz). */
export function blockFeatures(signal: Float32Array, sr: number): BlockFeatures[] {
  const n = Math.floor(signal.length / sr)
  const out: BlockFeatures[] = []
  const sub = Math.max(1, Math.round(sr * 0.02))
  const fft = makeFft(FFT_SIZE)
  const win = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))
  const env: number[] = []
  const lo = Math.max(1, Math.floor((100 * FFT_SIZE) / sr))
  const hi = Math.min(FFT_SIZE / 2 - 1, Math.floor((5000 * FFT_SIZE) / sr))
  for (let b = 0; b < n; b++) {
    const s0 = b * sr
    // volume e istanti quasi muti
    let acc = 0
    const subs: number[] = []
    for (let s = s0; s + sub <= s0 + sr; s += sub) {
      let a = 0
      for (let k = s; k < s + sub; k++) a += signal[k] * signal[k]
      acc += a
      subs.push(Math.sqrt(a / sub))
    }
    const rms = Math.sqrt(acc / sr)
    const meanSub = subs.reduce((x, y) => x + y, 0) / (subs.length || 1)
    const lowEnergy = meanSub > 0 ? subs.filter((v) => v < 0.5 * meanSub).length / subs.length : 1
    // piattezza dello spettro su qualche finestra del secondo
    let flat = 0
    let flatN = 0
    let prev: Float64Array | null = null
    let stab = 0
    let stabN = 0
    for (let f = 0; f < FFTS_PER_BLOCK; f++) {
      const start = s0 + Math.floor(((sr - FFT_SIZE) * f) / Math.max(1, FFTS_PER_BLOCK - 1))
      if (start + FFT_SIZE > signal.length) break
      const p = fft(signal, start, win)
      let logSum = 0
      let sum = 0
      for (let k = lo; k <= hi; k++) {
        const v = p[k] + 1e-12
        logSum += Math.log(v)
        sum += v
      }
      const m = hi - lo + 1
      if (sum > 1e-9 * m) {
        flat += Math.exp(logSum / m) / (sum / m)
        flatN++
      }
      const mag = new Float64Array(hi - lo + 1)
      for (let k = lo; k <= hi; k++) mag[k - lo] = Math.sqrt(p[k])
      if (prev) {
        stab += cosine(prev, mag)
        stabN++
      }
      prev = mag
    }
    out.push({
      db: rms > 0 ? 20 * Math.log10(rms) : -200,
      flatness: flatN ? flat / flatN : 0,
      lowEnergy,
      stability: stabN ? stab / stabN : 0,
      rhythm: 0
    })
    env.push(...subs)
  }
  // ritmo: autocorrelazione del volume (istanti da 20 ms) intorno a ogni secondo
  const perSec = Math.floor(sr / sub)
  // il più basso tra i 4 secondi che finiscono con questo e i 4 che cominciano con questo: vicino al confine tra
  // musica e parlato la musica accanto non deve far sembrare "a tempo" anche il parlato
  for (let b = 0; b < n; b++) {
    // all'inizio e alla fine del file una delle due finestre è troppo corta: vale l'altra
    const before = b >= 3 ? periodicity(env, (b - 3) * perSec, (b + 1) * perSec, perSec) : null
    const after = b + 4 <= n ? periodicity(env, b * perSec, (b + 4) * perSec, perSec) : null
    out[b].rhythm = Math.min(before ?? after ?? 0, after ?? before ?? 0)
  }
  return out
}

/** Picco dell'autocorrelazione del volume tra 0,25 e 1,5 secondi di distanza (1 = colpi perfettamente a tempo). */
function periodicity(env: number[], from: number, to: number, perSec: number): number {
  const x = env.slice(Math.floor(from), Math.floor(to))
  const n = x.length
  const minLag = Math.round(0.25 * perSec)
  const maxLag = Math.min(Math.round(1.5 * perSec), Math.floor(n / 2))
  if (maxLag <= minLag) return 0
  const m = x.reduce((a, b) => a + b, 0) / n
  const d = x.map((v) => v - m)
  const e0 = d.reduce((a, v) => a + v * v, 0)
  if (!(e0 > 0)) return 0
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0
    for (let i = 0; i + lag < n; i++) c += d[i] * d[i + lag]
    best = Math.max(best, (c / e0) * (n / (n - lag)))
  }
  return Math.min(1, best)
}

function cosine(a: Float64Array, b: Float64Array): number {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
}

/** Valori tipici del corpo del brano (parte centrale, solo secondi non silenziosi). */
export function bodyOf(blocks: BlockFeatures[]): BlockFeatures {
  const n = blocks.length
  const mid = blocks.slice(Math.floor(n * 0.2), Math.ceil(n * 0.8)).filter((b) => b.db > SILENCE_DBFS)
  const src = mid.length >= 5 ? mid : blocks.filter((b) => b.db > SILENCE_DBFS)
  if (!src.length) return { db: -200, flatness: 0, lowEnergy: 0, stability: 1, rhythm: 1 }
  const med = (f: (b: BlockFeatures) => number): number => percentile(src.map(f), 0.5)
  return { db: med((b) => b.db), flatness: med((b) => b.flatness), lowEnergy: med((b) => b.lowEnergy), stability: med((b) => b.stability), rhythm: med((b) => b.rhythm) }
}

/** Che cos'è un secondo, rispetto al corpo del brano. */
export function classify(b: BlockFeatures, body: BlockFeatures): BlockKind {
  if (b.db < SILENCE_DBFS || b.db < body.db - SILENCE_BELOW_BODY_DB) return 'silence'
  if (b.flatness >= Math.max(NOISE_FLATNESS, body.flatness * 2.5)) return 'noise'
  // parlato: tante pause tra le sillabe, suono che cambia di continuo e nessun passo regolare. Servono tutte e tre:
  // una batteria da sola ha le pause ma va a tempo, una chitarra arpeggiata ha le pause ma le note restano
  if (
    b.lowEnergy >= Math.max(SPEECH_LOW_ENERGY, body.lowEnergy + SPEECH_OVER_BODY) &&
    b.stability < Math.min(SPEECH_STABILITY, body.stability - 0.1) &&
    b.rhythm < SPEECH_RHYTHM
  )
    return 'speech'
  return 'music'
}

/**
 * Inizio e fine della musica tra `from` e `to` (secondi, già senza il silenzio iniziale e finale).
 * Se qualcosa non torna (brano corto, tutto "strano") si lasciano `from` e `to`.
 */
export function findMusicBounds(signal: Float32Array, sr: number, from: number, to: number): MusicBounds {
  const blocks = blockFeatures(signal, sr)
  const body = bodyOf(blocks)
  const kinds = smooth(blocks.map((b) => classify(b, body)))
  const b = boundsFromKinds(kinds, blocks, from, to)
  if (b.cutStart && b.cutStart !== 'silence') b.start = round(Math.max(from, exactStart(signal, sr, b.start)))
  return b
}

/**
 * Il secondo prima della musica è spesso metà parlato (o applausi) e metà musica: dentro quel secondo si cerca
 * l'ultima pausa (20 ms molto più bassi della musica che segue) e la musica parte da lì. Senza pausa si parte
 * dall'inizio di quel secondo: meglio un pezzetto di parlato che il primo colpo della canzone tagliato.
 */
function exactStart(signal: Float32Array, sr: number, approx: number): number {
  const a = Math.round(approx + 0.5)
  const sub = Math.max(1, Math.round(sr * 0.02))
  const rmsAt = (s: number): number => {
    let acc = 0
    for (let k = s; k < s + sub && k < signal.length; k++) acc += signal[k] * signal[k]
    return Math.sqrt(acc / sub)
  }
  const music: number[] = []
  for (let s = a * sr; s + sub <= Math.min(signal.length, (a + 3) * sr); s += sub) music.push(rmsAt(s))
  if (!music.length) return a - 1
  const quiet = percentile(music, 0.5) * 0.1
  let found = -1
  for (let s = Math.max(0, (a - 1) * sr); s + sub <= Math.min(signal.length, a * sr + sr / 2); s += sub) if (rmsAt(s) < quiet) found = s + sub
  return found >= 0 ? found / sr : Math.max(0, a - 1)
}

/** Parte "a regole" del calcolo, separata per le prove. `kinds[i]` = secondo da i a i+1. */
export function boundsFromKinds(kinds: BlockKind[], blocks: BlockFeatures[] | null, from: number, to: number): MusicBounds {
  const keep: MusicBounds = { start: round(from), end: round(to), cutStart: null, cutEnd: null }
  const first = Math.max(0, Math.ceil(from - 1e-6))
  const last = Math.min(kinds.length, Math.floor(to + 1e-6))
  if (last - first < 3 * MUSIC_RUN) return keep
  const isMusic = (i: number): boolean => kinds[i] === 'music'
  const runFrom = (i: number): boolean => {
    let c = 0
    for (let j = i; j < Math.min(last, i + MUSIC_RUN); j++) if (isMusic(j)) c++
    return c >= MUSIC_RUN - 1 && isMusic(i)
  }
  const runTo = (i: number): boolean => {
    let c = 0
    for (let j = Math.max(first, i - MUSIC_RUN + 1); j <= i; j++) if (isMusic(j)) c++
    return c >= MUSIC_RUN - 1 && isMusic(i)
  }
  let a = first
  while (a < last && !runFrom(a)) a++
  let z = last - 1
  while (z >= first && !runTo(z)) z--
  if (a >= z) return keep

  let start = from
  let cutStart: BlockKind | null = null
  if (a > first) {
    const what = dominant(kinds.slice(first, a))
    // il silenzio si taglia sempre; il resto solo entro il limite
    if (allSilence(kinds.slice(first, a)) || a - from <= MAX_CUT_START) {
      start = Math.max(from, refineStart(a))
      cutStart = what
    }
  }

  let end = to
  let cutEnd: MusicBounds['cutEnd'] = null
  // traccia fantasma: un lungo silenzio dopo abbastanza musica, e poi altro
  const hidden = findHiddenGap(kinds, a, z)
  if (hidden !== null) {
    end = hidden
    cutEnd = 'hidden'
    z = Math.ceil(hidden) - 1
  }
  if (cutEnd === null && z < last - 1) {
    const what = dominant(kinds.slice(z + 1, last))
    if (allSilence(kinds.slice(z + 1, last)) || to - (z + 1) <= MAX_CUT_END) {
      end = Math.min(to, refineEnd(blocks, kinds, z, to))
      cutEnd = what
    }
  }
  if (end - start < 3 * MUSIC_RUN) return keep
  return { start: round(start), end: round(end), cutStart, cutEnd }
}

/** Inizio di un silenzio interno dopo cui c'è una traccia fantasma (o null). */
function findHiddenGap(kinds: BlockKind[], a: number, z: number): number | null {
  let musicBefore = 0
  for (let i = a; i <= z; i++) {
    if (kinds[i] !== 'silence') {
      if (kinds[i] === 'music') musicBefore++
      continue
    }
    let j = i
    while (j <= z && kinds[j] === 'silence') j++
    const gap = j - i
    if (musicBefore >= HIDDEN_MIN_BEFORE && gap >= HIDDEN_GAP_SHORT) {
      const after = kinds.slice(j, z + 1)
      const afterMusic = after.filter((k) => k === 'music').length
      if (gap >= HIDDEN_GAP_LONG || after.length <= 60 || afterMusic < after.length / 2) return i
    }
    i = j - 1
  }
  return null
}

/** Il primo secondo di musica è "a" ma la musica può cominciare dentro il secondo precedente (vedi exactStart). */
function refineStart(a: number): number {
  return Math.max(0, a - 0.5)
}

/** Dopo l'ultimo secondo di musica si lascia un attimo di coda (riverbero, ultima nota). */
function refineEnd(blocks: BlockFeatures[] | null, kinds: BlockKind[], z: number, to: number): number {
  let end = z + 1
  if (blocks) {
    // la coda che scende piano si tiene (fino a 3 secondi), ma non se è già parlato o applausi
    for (let i = z + 1; i < Math.min(blocks.length, z + 4); i++) {
      if ((kinds[i] === 'music' || kinds[i] === 'silence') && blocks[i].db < blocks[i - 1].db - 1.5) end = i + 1
      else break
    }
  }
  return Math.min(to, end + 0.3)
}

/** Un secondo diverso in mezzo a due uguali è quasi sempre uno sbaglio della misura. */
export function smooth(kinds: BlockKind[]): BlockKind[] {
  return kinds.map((k, i) => (i > 0 && i < kinds.length - 1 && kinds[i - 1] === kinds[i + 1] && k !== kinds[i - 1] ? kinds[i - 1] : k))
}

/** Il tipo più frequente fuori dalla musica (per dire cosa si è tagliato): rumore o parlato prima del silenzio. */
function dominant(kinds: BlockKind[]): BlockKind {
  const count: Record<BlockKind, number> = { music: 0, silence: 0, noise: 0, speech: 0 }
  for (const k of kinds) count[k]++
  if (count.noise || count.speech) return count.noise >= count.speech ? 'noise' : 'speech'
  return count.silence ? 'silence' : 'music'
}

/** Solo silenzio: si taglia sempre, anche se lungo. */
function allSilence(kinds: BlockKind[]): boolean {
  return kinds.length > 0 && kinds.every((k) => k === 'silence')
}

/** FFT reale semplice (radice 2): restituisce lo spettro di potenza di `size` campioni da `start`. */
function makeFft(size: number): (x: Float32Array, start: number, win: Float32Array) => Float64Array {
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const out = new Float64Array(size / 2)
  const levels = Math.log2(size)
  const rev = new Uint32Array(size)
  for (let i = 0; i < size; i++) {
    let r = 0
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(size / 2)
  const sin = new Float64Array(size / 2)
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size)
    sin[i] = Math.sin((2 * Math.PI * i) / size)
  }
  return (x, start, win) => {
    for (let i = 0; i < size; i++) {
      re[rev[i]] = x[start + i] * win[i]
      im[rev[i]] = 0
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1
      const step = size / len
      for (let i = 0; i < size; i += len) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step]
          const wi = -sin[j * step]
          const k = i + j
          const l = k + half
          const tr = re[l] * wr - im[l] * wi
          const ti = re[l] * wi + im[l] * wr
          re[l] = re[k] - tr
          im[l] = im[k] - ti
          re[k] += tr
          im[k] += ti
        }
      }
    }
    for (let i = 0; i < size / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i]
    return out
  }
}

function percentile(x: number[], p: number): number {
  if (!x.length) return 0
  const s = [...x].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))]
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
