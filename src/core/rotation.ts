import type { Track } from './types'

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
  random: () => number = Math.random
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
    const pool = candidates.filter(ok)
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
