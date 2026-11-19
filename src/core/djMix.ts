/**
 * Mix DJ: decide come passare da un brano all'altro a tempo, come farebbe un DJ.
 *
 * - Il brano che entra (B) segue il tempo di quello che esce (A), al massimo ±6%, senza cambiare intonazione,
 *   poi torna piano piano alla sua velocità.
 * - B parte dal suo primo "uno" nello stesso istante in cui A arriva all'inizio di una frase.
 * - Prima B entra senza bassi, a metà del mix i bassi passano da A a B, poi A sfuma.
 * - Se il finale di A è troppo corto per l'intro di B, A ripete in loop le sue ultime 4 battute piene.
 *
 * Qui c'è solo il piano (numeri): l'audio lo fa la regia.
 */
import { foldBpm, MIN_GRID_CONFIDENCE, PHRASE_BARS } from './djAnalysis'
import type { Track } from './types'

/** Variazione massima di velocità del brano che entra (6% = circa un semitono se non si correggesse). */
export const DEFAULT_MAX_STRETCH = 0.06
/** Battute del loop. */
export const LOOP_BARS = 4

export interface MixPlan {
  /** Secondi in A: inizio del mix (un "uno" a inizio frase). */
  aStart: number
  /** Secondi in B: da dove parte B (il suo primo "uno"). */
  bStart: number
  /** Battute di sovrapposizione. */
  bars: number
  /** Durata di una battuta di A, in secondi. */
  barSeconds: number
  /** Durata del mix in secondi. */
  seconds: number
  /** Velocità di B durante il mix (1 = normale). */
  rate: number
  /** Loop sul finale di A (secondi in A), ripetuto finché serve. null = nessun loop. */
  loop: { start: number; end: number } | null
  /** Secondi dall'inizio del mix in cui i bassi passano da A a B. */
  bassSwapAt: number
}

export type MixDecision = { ok: true; plan: MixPlan } | { ok: false; reason: string }

/** Rapporto di velocità per portare `bpmB` a `bpmA`, provando anche metà e doppio. */
export function tempoRatio(bpmA: number, bpmB: number): number {
  let best = Infinity
  for (const k of [0.5, 1, 2]) {
    const r = bpmA / (bpmB * k)
    if (Math.abs(Math.log(r)) < Math.abs(Math.log(best))) best = r
  }
  return best
}

/** Il piano del mix da A a B, oppure il motivo per cui si usa la dissolvenza normale. */
export function planMix(a: Track, b: Track, maxStretch = DEFAULT_MAX_STRETCH): MixDecision {
  if (a.kind !== 'music' || b.kind !== 'music') return { ok: false, reason: 'non è musica' }
  const da = a.dj
  const db = b.dj
  if (!da || !db) return { ok: false, reason: 'analisi DJ non ancora fatta' }
  if (!(da.bpm > 0) || da.gridConfidence < MIN_GRID_CONFIDENCE) return { ok: false, reason: `"${a.title}" non ha un ritmo regolare` }
  if (!(db.bpm > 0) || db.gridConfidence < MIN_GRID_CONFIDENCE) return { ok: false, reason: `"${b.title}" non ha un ritmo regolare` }
  const rate = tempoRatio(da.bpm, db.bpm)
  if (Math.abs(rate - 1) > maxStretch + 1e-9) {
    return { ok: false, reason: `tempi troppo diversi (${Math.round(foldBpm(da.bpm))} e ${Math.round(foldBpm(db.bpm))} BPM)` }
  }

  const barA = (4 * 60) / da.bpm
  const barB = (4 * 60) / db.bpm
  const endA = a.cueOut > a.cueIn ? a.cueOut : a.duration
  const endB = b.cueOut > b.cueIn ? b.cueOut : b.duration
  // battute di A da un "uno" a un altro: la griglia parte da firstDownbeat
  const barIndexA = (t: number): number => Math.floor((t - da.firstDownbeat) / barA + 1e-6)
  const barTimeA = (i: number): number => da.firstDownbeat + i * barA

  // lunghezza del mix: l'intro di B se è lunga, altrimenti 8 battute
  const introBarsB = Math.floor((db.introEnd - db.firstDownbeat) / barB + 1e-6)
  const bars = introBarsB >= 16 ? 16 : PHRASE_BARS
  if (db.firstDownbeat + bars * barB > endB) return { ok: false, reason: `"${b.title}" è troppo corto` }

  // l'outro di A comincia a inizio frase; le battute "sicure" sono quelle che finiscono prima della fine dell'audio
  const lastBarA = barIndexA(endA) // battute intere fino alla fine
  const outroBar = Math.min(lastBarA, Math.max(0, Math.round((da.outroStart - da.firstDownbeat) / barA)))
  const available = lastBarA - outroBar
  if (lastBarA < LOOP_BARS + 1) return { ok: false, reason: `"${a.title}" è troppo corto` }

  let startBar: number
  let loop: MixPlan['loop'] = null
  if (available >= bars) {
    // l'outro basta: il mix finisce con la fine dell'outro, partendo a inizio frase
    const slack = available - bars
    startBar = outroBar + Math.floor(slack / PHRASE_BARS) * PHRASE_BARS
  } else {
    // outro corto: loop delle ultime 4 battute piene, quelle prima dell'outro (che si salta)
    const loopEndBar = outroBar
    const loopStartBar = loopEndBar - LOOP_BARS
    if (loopStartBar < 0) return { ok: false, reason: `"${a.title}" è troppo corto per il loop` }
    loop = { start: round(barTimeA(loopStartBar)), end: round(barTimeA(loopEndBar)) }
    startBar = loopStartBar
  }
  const aStart = barTimeA(startBar)
  if (aStart < a.cueIn) return { ok: false, reason: `"${a.title}" è troppo corto` }
  const seconds = bars * barA
  return {
    ok: true,
    plan: {
      aStart: round(aStart),
      bStart: round(db.firstDownbeat),
      bars,
      barSeconds: round(barA),
      seconds: round(seconds),
      rate: Math.round(rate * 10000) / 10000,
      loop,
      bassSwapAt: round(seconds / 2)
    }
  }
}

/** Quanto dura il passaggio di velocità di B da `rate` a 1 dopo il mix (secondi). */
export function rateRampSeconds(plan: MixPlan): number {
  return plan.rate === 1 ? 0 : plan.barSeconds * 8
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
