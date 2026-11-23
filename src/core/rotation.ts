import { keysCompatible, MIN_GRID_CONFIDENCE } from './djAnalysis'
import { tempoRatio } from './djMix'
import type { Track } from './types'

/** Preferenze "morbide": se nessun brano le rispetta tutte si rinuncia prima alla più debole. */
export interface FlowRules {
  /** Ultimo brano di musica prima di quello da scegliere (in onda o in coda). */
  prev: Track | null
  /** Mix DJ acceso: preferire brani mixabili con `prev` (BPM vicini, tonalità compatibile). */
  djMix: boolean
  /** Variazione massima di velocità del Mix DJ (0.06 = ±6%). */
  maxStretch: number
  /** Salto massimo di energia tra due brani (0 = nessun limite). */
  maxEnergyJump: number
  /** Energia ammessa (es. 3-6), null = qualsiasi. */
  energyRange?: { min: number; max: number } | null
  /** Con il Mix DJ acceso: questa volta cambiare tempo (BPM fuori dal limite del mix a tempo) invece di restare sullo stesso. */
  tempoChange?: boolean
}

/** Salto massimo di energia predefinito tra un brano e il successivo. */
export const DEFAULT_ENERGY_JUMP = 2

/** Tempi vicini: il mix a tempo li aggancia (metà e doppio contano). */
export function sameTempo(a: Track, b: Track, maxStretch: number): boolean {
  const da = a.dj
  const db = b.dj
  if (!da || !db || !(da.bpm > 0) || !(db.bpm > 0)) return false
  return Math.abs(tempoRatio(da.bpm, db.bpm) - 1) <= maxStretch + 1e-9
}

/** Due brani si possono mixare a tempo: ritmo regolare, BPM vicini, tonalità compatibile. */
export function mixable(a: Track, b: Track, maxStretch: number): boolean {
  const da = a.dj
  const db = b.dj
  if (!da || !db || !(da.bpm > 0) || !(db.bpm > 0)) return false
  if (da.gridConfidence < MIN_GRID_CONFIDENCE || db.gridConfidence < MIN_GRID_CONFIDENCE) return false
  if (Math.abs(tempoRatio(da.bpm, db.bpm) - 1) > maxStretch + 1e-9) return false
  return keysCompatible(da.key, db.key)
}

/** Filtri dal più importante al meno: si prova con tutti, poi si toglie l'ultimo, e così via. */
function flowFilters(flow: FlowRules | undefined): ((t: Track) => boolean)[] {
  if (!flow) return []
  const out: ((t: Track) => boolean)[] = []
  const r = flow.energyRange
  if (r) out.push((t) => !(t.dj?.energy) || (t.dj.energy >= r.min && t.dj.energy <= r.max))
  const pe = flow.prev?.dj?.energy ?? 0
  if (flow.maxEnergyJump > 0 && pe > 0) out.push((t) => !(t.dj?.energy) || Math.abs(t.dj.energy - pe) <= flow.maxEnergyJump)
  const prev = flow.prev
  if (flow.djMix && prev) {
    // ogni tanto si cambia tempo (il passaggio sarà eco, riverbero, stacco…), altrimenti brani mixabili a tempo
    if (flow.tempoChange && prev.dj?.bpm) out.push((t) => !!t.dj?.bpm && !sameTempo(prev, t, flow.maxStretch))
    else out.push((t) => mixable(prev, t, flow.maxStretch))
  }
  return out
}

/** Restringe il gruppo con le preferenze, rinunciando alle meno importanti se lo svuotano. */
export function preferFlow(pool: Track[], flow: FlowRules | undefined): Track[] {
  const filters = flowFilters(flow)
  for (let n = filters.length; n > 0; n--) {
    const narrowed = pool.filter((t) => filters.slice(0, n).every((f) => f(t)))
    if (narrowed.length) return narrowed
  }
  return pool
}

export interface RecentPlay {
  trackId: number | null
  artist: string
  /** ISO date. */
  startedAt: string
}

export interface RotationRules {
  artistSeparationMinutes: number
  titleSeparationMinutes: number
  jingleEvery: number
}

export interface RotationState {
  /** Brani musicali messi in coda dall'ultimo jingle. */
  musicSinceJingle: number
}

function normArtist(a: string): string {
  return a.trim().toLowerCase()
}

/**
 * Sceglie il prossimo brano musicale rispettando le separazioni.
 * Se nessun brano rispetta tutte le regole, rilassa prima la separazione artista,
 * poi quella del titolo, così la radio non resta mai muta.
 *
 * @param upcoming brani già in coda, con l'orario stimato di messa in onda
 */
export function pickMusic(
  candidates: Track[],
  recent: RecentPlay[],
  upcoming: { track: Track; at: Date }[],
  at: Date,
  rules: RotationRules,
  random: () => number = Math.random,
  flow?: FlowRules
): Track | null {
  if (!candidates.length) return null
  const artistWindow = rules.artistSeparationMinutes * 60_000
  const titleWindow = rules.titleSeparationMinutes * 60_000

  const lastByTrack = new Map<number, number>()
  const lastByArtist = new Map<string, number>()
  const note = (id: number | null, artist: string, t: number): void => {
    if (id != null) lastByTrack.set(id, Math.max(lastByTrack.get(id) ?? -Infinity, t))
    const a = normArtist(artist)
    if (a) lastByArtist.set(a, Math.max(lastByArtist.get(a) ?? -Infinity, t))
  }
  for (const r of recent) note(r.trackId, r.artist, Date.parse(r.startedAt))
  for (const u of upcoming) note(u.track.id, u.track.artist, u.at.getTime())

  const now = at.getTime()
  const titleOk = (t: Track): boolean => Math.abs(now - (lastByTrack.get(t.id) ?? -Infinity)) >= titleWindow
  const artistOk = (t: Track): boolean => {
    const a = normArtist(t.artist)
    return !a || Math.abs(now - (lastByArtist.get(a) ?? -Infinity)) >= artistWindow
  }

  const tiers: ((t: Track) => boolean)[] = [(t) => titleOk(t) && artistOk(t), titleOk, () => true]
  for (const ok of tiers) {
    const pool = preferFlow(candidates.filter(ok), flow)
    if (pool.length) {
      // Preferisce i brani che non vanno in onda da più tempo (o mai), con un po' di casualità.
      pool.sort((a, b) => (lastByTrack.get(a.id) ?? -Infinity) - (lastByTrack.get(b.id) ?? -Infinity))
      const head = pool.slice(0, Math.max(1, Math.ceil(pool.length / 3)))
      return head[Math.floor(random() * head.length)]
    }
  }
  return null
}

/** Sceglie un jingle a caso evitando l'ultimo usato. */
export function pickJingle(jingles: Track[], lastJingleId: number | null, random: () => number = Math.random): Track | null {
  if (!jingles.length) return null
  const pool = jingles.length > 1 ? jingles.filter((j) => j.id !== lastJingleId) : jingles
  return pool[Math.floor(random() * pool.length)]
}

/** Durata effettiva in onda: da inizio a punto di mix. */
export function airTime(t: Track): number {
  const end = t.mixPoint > t.cueIn ? t.mixPoint : t.cueOut > t.cueIn ? t.cueOut : t.duration
  return Math.max(1, end - t.cueIn)
}
