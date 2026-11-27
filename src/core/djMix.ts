/**
 * Mix DJ: decide come passare da un brano all'altro a tempo, come farebbe un DJ.
 *
 * - Il brano che entra (B) segue il tempo di quello che esce (A), al massimo ±6%, senza cambiare intonazione,
 *   poi torna piano piano alla sua velocità.
 * - B parte dal suo primo "uno" nello stesso istante in cui A arriva all'inizio di una frase.
 * - Prima B entra senza bassi, a metà del mix i bassi passano da A a B, poi A sfuma.
 * - Se il finale di A è troppo corto per l'intro di B, A ripete in loop le sue ultime 4 battute piene.
 *
 * Oltre al mix lungo ci sono gli altri passaggi di un DJ (vedi MIX_STYLES): filtro, eco, riverbero, stacco,
 * rullo, frenata e riavvolto. Quelli che non mettono i brani a tempo funzionano anche con BPM molto diversi.
 *
 * Qui c'è solo il piano (numeri): l'audio lo fa la regia.
 */
import { foldBpm, keysCompatible, MIN_GRID_CONFIDENCE, PHRASE_BARS } from './djAnalysis'
import type { Track } from './types'

/** Variazione massima di velocità del brano che entra (6% = circa un semitono se non si correggesse). */
export const DEFAULT_MAX_STRETCH = 0.06
/** Battute del loop. */
export const LOOP_BARS = 4

/** Tipi di passaggio. */
export type MixStyle = 'blend' | 'filter' | 'echo' | 'reverb' | 'cut' | 'roll' | 'brake' | 'spinback'

export const MIX_STYLES: { id: MixStyle; label: string; help: string; showy?: boolean }[] = [
  { id: 'blend', label: 'Mix lungo', help: 'i due brani a tempo per 8 o 16 battute, con lo scambio dei bassi' },
  { id: 'filter', label: 'Filtro', help: 'a tempo; il brano che esce si chiude in un filtro, quello che entra si apre' },
  { id: 'echo', label: 'Eco', help: 'il brano che esce si ripete in eco sul battito, il nuovo entra sulla battuta dopo', showy: true },
  { id: 'reverb', label: 'Riverbero', help: 'il brano che esce si scioglie in un riverbero lungo', showy: true },
  { id: 'cut', label: 'Stacco', help: 'stacco secco sul primo tempo, il nuovo brano parte pieno', showy: true },
  { id: 'roll', label: 'Rullo', help: 'loop che si accorcia (1, 1/2, 1/4, 1/8 di battito) e il nuovo brano "esplode"', showy: true },
  { id: 'brake', label: 'Frenata', help: 'il brano si ferma come un giradischi spento', showy: true },
  { id: 'spinback', label: 'Riavvolto', help: 'il disco gira all\'indietro (spinback) e parte il nuovo', showy: true }
]

export const ALL_MIX_STYLES: MixStyle[] = MIX_STYLES.map((m) => m.id)

export function mixStyleLabel(s: MixStyle): string {
  return MIX_STYLES.find((m) => m.id === s)?.label ?? s
}

/** Passaggi a tempo: chiedono BPM vicini. */
const SYNCED: MixStyle[] = ['blend', 'filter']
/**
 * Passaggi vistosi (tutti quelli che non sovrappongono i brani a tempo): la scelta automatica li usa al massimo una
 * volta ogni SHOWY_EVERY cambi. Negli altri cambi con tempi lontani va la sfumatura incrociata normale, così i brani
 * si sovrappongono sempre e non suonano "uno in coda all'altro".
 */
export const SHOWY_EVERY = 4

export interface MixPlan {
  /** Tipo di passaggio. */
  style: MixStyle
  /**
   * Secondi dall'inizio del passaggio in cui si sente il brano che entra (0 nei passaggi a tempo).
   * Nei passaggi a tempo `seconds` è la durata della sovrapposizione; negli altri è quando A ha finito del tutto.
   */
  bIn: number
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
  /**
   * Punti di aggancio battuta per battuta (passaggi a tempo): `aBars[k]` secondi dall'inizio del mix (nel tempo di A)
   * corrispondono a `bBars[k]` secondi nel file di B. Così B segue anche i brani che accelerano o rallentano.
   */
  aBars?: number[]
  bBars?: number[]
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

/**
 * Le battute di un brano: dagli "uno" seguiti uno a uno (analisi nuova) o dalla griglia fissa (analisi vecchia).
 * Prima del primo e dopo l'ultimo "uno" conosciuto si prosegue con il passo delle battute vicine.
 */
export interface BarGrid {
  /** Secondi dell'"uno" della battuta `i` (0 = primo "uno"). */
  time(i: number): number
  /** Battuta in cui cade il secondo `t` (anche negativa). */
  index(t: number): number
  /** Battuta con l'"uno" più vicino al secondo `t`. */
  nearest(t: number): number
}

export function barGrid(d: NonNullable<Track['dj']>): BarGrid {
  const bar = (4 * 60) / d.bpm
  const db = d.downbeats && d.downbeats.length >= 2 ? d.downbeats : null
  if (!db) {
    return {
      time: (i) => d.firstDownbeat + i * bar,
      index: (t) => Math.floor((t - d.firstDownbeat) / bar + 1e-6),
      nearest: (t) => Math.round((t - d.firstDownbeat) / bar)
    }
  }
  const n = db.length
  const k = Math.min(4, n - 1)
  const headBar = (db[k] - db[0]) / k
  const tailBar = (db[n - 1] - db[n - 1 - k]) / k
  const time = (i: number): number => (i < 0 ? db[0] + i * headBar : i >= n ? db[n - 1] + (i - n + 1) * tailBar : db[i])
  const index = (t: number): number => {
    if (t < db[0]) return Math.floor((t - db[0]) / headBar + 1e-6)
    if (t >= db[n - 1]) return n - 1 + Math.floor((t - db[n - 1]) / tailBar + 1e-6)
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (db[m] <= t + 1e-6) lo = m
      else hi = m - 1
    }
    return lo
  }
  return {
    time,
    index,
    nearest: (t) => {
      const i = index(t)
      return t - time(i) > time(i + 1) - t ? i + 1 : i
    }
  }
}

/** Il piano del mix da A a B, oppure il motivo per cui si usa la dissolvenza normale. */
export function planMix(a: Track, b: Track, maxStretch = DEFAULT_MAX_STRETCH): MixDecision {
  if (a.kind !== 'music' || b.kind !== 'music') return { ok: false, reason: 'non è musica' }
  const da = a.dj
  const db = b.dj
  if (!da || !db) return { ok: false, reason: 'analisi DJ non ancora fatta' }
  if (!(da.bpm > 0) || da.gridConfidence < MIN_GRID_CONFIDENCE) return { ok: false, reason: `"${a.title}" non ha un ritmo regolare` }
  if (!(db.bpm > 0) || db.gridConfidence < MIN_GRID_CONFIDENCE) return { ok: false, reason: `"${b.title}" non ha un ritmo regolare` }
  if (Math.abs(tempoRatio(da.bpm, db.bpm) - 1) > maxStretch + 0.02) {
    return { ok: false, reason: `tempi troppo diversi (${Math.round(foldBpm(da.bpm))} e ${Math.round(foldBpm(db.bpm))} BPM)` }
  }

  const ga = barGrid(da)
  const gb = barGrid(db)
  const endA = a.cueOut > a.cueIn ? a.cueOut : a.duration
  const endB = b.cueOut > b.cueIn ? b.cueOut : b.duration
  // battute di B per ogni battuta di A: 1, oppure 2 o 1/2 se uno dei due brani è stato "sentito" a metà o al doppio
  const per = Math.round(Math.log2(tempoRatio(da.bpm, db.bpm) * (da.bpm / db.bpm)))
  const bPerA = 2 ** -per

  // lunghezza del mix: l'intro di B se è lunga, altrimenti 8 battute (contate in battute di A)
  const introBarsB = gb.index(db.introEnd) / bPerA
  const bars = introBarsB >= 16 ? 16 : PHRASE_BARS
  if (gb.time(Math.ceil(bars * bPerA)) > endB) return { ok: false, reason: `"${b.title}" è troppo corto` }

  // l'outro di A comincia a inizio frase; le battute "sicure" sono quelle che finiscono prima della fine dell'audio
  const lastBarA = ga.index(endA) // battute intere fino alla fine
  const outroBar = Math.min(lastBarA, Math.max(0, ga.nearest(da.outroStart)))
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
    loop = { start: round(ga.time(loopStartBar)), end: round(ga.time(loopEndBar)) }
    startBar = loopStartBar
  }
  const aStart = ga.time(startBar)
  if (aStart < a.cueIn) return { ok: false, reason: `"${a.title}" è troppo corto` }

  // "uno" di A durante il mix, in secondi dall'inizio del mix (con il loop le 4 battute si ripetono)
  const aOff: number[] = [0]
  for (let j = 0; j < bars; j++) {
    const i = loop ? startBar + (j % LOOP_BARS) : startBar + j
    aOff.push(aOff[j] + ga.time(i + 1) - ga.time(i))
  }
  // punti di aggancio: ogni "uno" comune ai due brani (con metà/doppio uno ogni due)
  const aBars: number[] = []
  const bBars: number[] = []
  const stepA = Math.max(1, Math.round(1 / bPerA))
  for (let j = 0; j <= bars; j += stepA) {
    aBars.push(round(aOff[j]))
    bBars.push(round(gb.time(Math.round(j * bPerA))))
  }
  const seconds = aOff[bars]
  const rate = (bBars[bBars.length - 1] - bBars[0]) / (aBars[aBars.length - 1] - aBars[0])
  if (Math.abs(rate - 1) > maxStretch + 1e-9) {
    return { ok: false, reason: `tempi troppo diversi (${Math.round(foldBpm(da.bpm))} e ${Math.round(foldBpm(db.bpm))} BPM)` }
  }
  return {
    ok: true,
    plan: {
      style: 'blend',
      bIn: 0,
      aStart: round(aStart),
      bStart: bBars[0],
      bars,
      barSeconds: round(seconds / bars),
      seconds: round(seconds),
      rate: Math.round(rate * 10000) / 10000,
      loop,
      bassSwapAt: round(aOff[bars / 2]),
      aBars,
      bBars
    }
  }
}

/**
 * Dove deve essere B (secondi nel file) quando A è a `x` secondi dall'inizio del mix, e la velocità di B in quel
 * tratto: segue gli "uno" dei due brani battuta per battuta. Prima e dopo il mix prosegue con la prima e l'ultima battuta.
 */
export function mixTarget(plan: MixPlan, x: number): { pos: number; rate: number } {
  const a = plan.aBars
  const b = plan.bBars
  if (!a || !b || a.length < 2) return { pos: plan.bStart + plan.rate * x, rate: plan.rate }
  let k = 0
  while (k + 2 < a.length && x >= a[k + 1]) k++
  const rate = (b[k + 1] - b[k]) / (a[k + 1] - a[k])
  return { pos: b[k] + (x - a[k]) * rate, rate }
}

/** Quanto dura il passaggio di velocità di B da `rate` a 1 dopo il mix (secondi). */
export function rateRampSeconds(plan: MixPlan): number {
  return plan.rate === 1 ? 0 : plan.barSeconds * 8
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ---------- gli altri passaggi ----------

function gridOk(t: Track): boolean {
  if (!t.dj || !(t.dj.bpm > 0) || t.dj.gridConfidence < MIN_GRID_CONFIDENCE) return false
  // analisi DJ fatta prima che inizio o fine si spostassero (parlato o applausi tagliati): finché non si rifà,
  // il primo "uno" potrebbe cadere nella parte tagliata e il mix non sul battito
  if (t.dj.firstDownbeat < t.cueIn - 0.3) return false
  if (t.cueOut > t.cueIn && t.dj.outroStart > t.cueOut + 0.3) return false
  return true
}

/** Battuta di uscita di A: inizio di una frase nell'outro, almeno una battuta prima della fine. */
function exitBar(a: Track): { bar: number; barA: number; time: (i: number) => number } | null {
  const d = a.dj!
  const g = barGrid(d)
  const endA = a.cueOut > a.cueIn ? a.cueOut : a.duration
  const lastBar = g.index(endA)
  if (lastBar < 4) return null
  const outroBar = Math.min(lastBar, Math.max(0, g.nearest(d.outroStart)))
  const available = lastBar - outroBar
  const bar = Math.min(lastBar - 1, outroBar + Math.floor(Math.max(0, available - 1) / PHRASE_BARS) * PHRASE_BARS)
  return { bar, barA: g.time(bar + 1) - g.time(bar), time: g.time }
}

/** Battute di intro di B (0 se parte pieno; null se non si sa). */
function introBars(b: Track): number | null {
  if (!gridOk(b)) return null
  const d = b.dj!
  return Math.floor((d.introEnd - d.firstDownbeat) / ((4 * 60) / d.bpm) + 1e-6)
}

/** Piano di un passaggio che non mette i brani a tempo: conta solo la griglia di A. */
export function planExit(a: Track, b: Track, style: Exclude<MixStyle, 'blend' | 'filter'>): MixDecision {
  if (a.kind !== 'music' || b.kind !== 'music') return { ok: false, reason: 'non è musica' }
  if (!gridOk(a)) return { ok: false, reason: a.dj ? `"${a.title}" non ha un ritmo regolare` : 'analisi DJ non ancora fatta' }
  const x = exitBar(a)
  if (!x) return { ok: false, reason: `"${a.title}" è troppo corto` }
  const beat = x.barA / 4
  // il rullo finisce sulla battuta d'uscita: comincia due battute prima
  const startBar = style === 'roll' ? x.bar - 2 : x.bar
  const aStart = x.time(startBar)
  if (startBar < 0 || aStart < a.cueIn + (style === 'reverb' ? x.barA : 0)) return { ok: false, reason: `"${a.title}" è troppo corto` }
  const bStart = gridOk(b) ? b.dj!.firstDownbeat : b.cueIn
  let bIn = 0
  let seconds = 0.05
  switch (style) {
    case 'cut':
      break
    case 'echo':
      bIn = x.barA
      seconds = 2 * x.barA
      break
    case 'reverb':
      bIn = 2 * beat
      seconds = Math.max(4, 2 * x.barA)
      break
    case 'roll':
      bIn = 2 * x.barA
      seconds = bIn + 0.05
      break
    case 'brake':
      bIn = x.barA
      seconds = 2 * beat + 0.1
      break
    case 'spinback':
      bIn = Math.max(x.barA, SPINBACK_SECONDS + 0.1)
      seconds = SPINBACK_SECONDS + 0.1
      break
  }
  return {
    ok: true,
    plan: {
      style,
      bIn: round(bIn),
      aStart: round(aStart),
      bStart: round(bStart),
      bars: 0,
      barSeconds: round(x.barA),
      seconds: round(seconds),
      rate: 1,
      loop: null,
      bassSwapAt: 0
    }
  }
}

/** Durata del riavvolto (secondi). */
export const SPINBACK_SECONDS = 1.6

export interface TransitionContext {
  /** Variazione massima di velocità per i passaggi a tempo. */
  maxStretch?: number
  /** Passaggi permessi (impostazioni). */
  allowed?: MixStyle[]
  /** Passaggio scelto dalla regia per il prossimo cambio; null = scelta automatica. */
  force?: MixStyle | null
  /** Cambi da quando si è sentito l'ultimo passaggio vistoso. */
  sinceShowy?: number
  /** Ultimo passaggio fatto. */
  last?: MixStyle | null
}

/** Se non si può fare un passaggio, si prova il successivo della lista. */
const FALLBACK: Record<MixStyle, MixStyle[]> = {
  blend: ['blend', 'filter'],
  filter: ['filter', 'blend'],
  roll: ['roll', 'cut', 'echo', 'reverb'],
  cut: ['cut', 'echo', 'reverb'],
  brake: ['brake', 'spinback', 'echo', 'reverb'],
  spinback: ['spinback', 'brake', 'echo', 'reverb'],
  echo: ['echo', 'reverb', 'cut'],
  reverb: ['reverb', 'echo', 'cut']
}

function planStyle(a: Track, b: Track, style: MixStyle, maxStretch: number): MixDecision {
  if (!SYNCED.includes(style)) return planExit(a, b, style as Exclude<MixStyle, 'blend' | 'filter'>)
  const d = planMix(a, b, maxStretch)
  return d.ok ? { ok: true, plan: { ...d.plan, style } } : d
}

/**
 * Sceglie il passaggio da A a B, come farebbe un DJ:
 * - BPM vicini: mix lungo, o filtro se le tonalità stridono; rullo ogni tanto se B è molto più carico;
 * - BPM lontani: di solito nessun piano (il motore fa la sfumatura incrociata, i brani si sovrappongono); ogni
 *   SHOWY_EVERY cambi un effetto: stacco se B parte pieno ed è carico almeno quanto A; frenata o riavvolto se B è
 *   molto più calmo; rullo se è molto più carico; altrimenti eco e riverbero, alternati.
 */
export function planTransition(a: Track, b: Track, ctx: TransitionContext = {}): MixDecision {
  const maxStretch = ctx.maxStretch ?? DEFAULT_MAX_STRETCH
  const allowed = ctx.allowed ?? ALL_MIX_STYLES
  if (ctx.force) {
    const d = planStyle(a, b, ctx.force, maxStretch)
    return d.ok ? d : { ok: false, reason: `${mixStyleLabel(ctx.force)} non possibile: ${d.reason}` }
  }
  if (!allowed.length) return { ok: false, reason: 'nessun passaggio permesso nelle impostazioni' }
  const synced = planMix(a, b, maxStretch)
  const showyOk = (ctx.sinceShowy ?? SHOWY_EVERY) >= SHOWY_EVERY - 1
  const ea = a.dj?.energy || 0
  const eb = b.dj?.energy || 0
  const known = ea > 0 && eb > 0
  const up = known && eb >= ea + 2
  const down = known && eb <= ea - 2
  let wanted: MixStyle
  if (synced.ok) {
    if (showyOk && up) wanted = 'roll'
    else if (!keysCompatible(a.dj!.key, b.dj!.key)) wanted = 'filter'
    else wanted = 'blend'
  } else {
    // tempi lontani: di solito la sfumatura incrociata normale (decide il motore), ogni tanto un effetto
    if (!showyOk) return { ok: false, reason: 'ritmi diversi, sfumatura incrociata' }
    const intro = introBars(b)
    if (intro !== null && intro < 2 && (!known || eb >= ea)) wanted = 'cut'
    else if (showyOk && down) wanted = ctx.last === 'brake' ? 'spinback' : 'brake'
    else if (showyOk && up) wanted = 'roll'
    else wanted = ctx.last === 'echo' ? 'reverb' : 'echo'
  }
  let first: MixDecision | null = null
  for (const s of FALLBACK[wanted]) {
    if (!allowed.includes(s) || (isShowy(s) && !showyOk)) continue
    const d = planStyle(a, b, s, maxStretch)
    if (d.ok) return d
    first ??= d
  }
  // nessun passaggio di quel tipo va bene: si prova il mix lungo e poi l'eco
  for (const s of ['blend', 'echo'] as MixStyle[]) {
    if (!allowed.includes(s) || FALLBACK[wanted].includes(s) || (isShowy(s) && !showyOk)) continue
    const d = planStyle(a, b, s, maxStretch)
    if (d.ok) return d
  }
  if (first) return first
  return synced.ok ? { ok: false, reason: 'passaggio escluso nelle impostazioni' } : synced
}

export function isShowy(s: MixStyle): boolean {
  return !!MIX_STYLES.find((m) => m.id === s)?.showy
}

export function describePlan(p: MixPlan): string {
  if (p.style === 'blend' || p.style === 'filter') {
    return `${mixStyleLabel(p.style)}: ${p.bars} battute${p.loop ? ' con loop' : ''}`
  }
  return mixStyleLabel(p.style)
}
