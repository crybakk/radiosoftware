/**
 * Conto alla rovescia dell'intro per lo speaker: quanto manca alla fine dell'intro (dall'analisi per il Mix DJ),
 * cioè quanto tempo c'è per parlare sopra la musica prima che il brano "parta".
 */
import type { Track } from './types'

/** Un'intro più corta di così non serve a parlarci sopra. */
export const MIN_INTRO_SECONDS = 3

/** Secondi di intro del brano dall'inizio dell'audio. 0 = nessuna intro utile o brano non analizzato. */
export function introSeconds(t: Track): number {
  const d = t.dj
  if (!d || t.kind !== 'music' || !(d.bpm > 0)) return 0
  const s = d.introEnd - t.cueIn
  return s >= MIN_INTRO_SECONDS ? Math.round(s * 10) / 10 : 0
}

/** Secondi che mancano alla fine dell'intro alla posizione `position` (secondi nel file). null = intro finita o assente. */
export function introLeft(t: Track, position: number): number | null {
  if (!introSeconds(t)) return null
  const left = t.dj!.introEnd - position
  return left > 0 ? left : null
}
