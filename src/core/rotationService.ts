import type { RadioDb } from './db'
import { pickJingle, pickMusic, type RotationRules } from './rotation'
import type { RotationProfile, Track } from './types'

/**
 * Filtra i brani secondo il profilo attivo. Se il filtro lascia meno di 10 brani
 * usa tutta la musica, così una regola troppo stretta non blocca la radio.
 */
export function applyProfile(tracks: Track[], profile: RotationProfile | null): Track[] {
  if (!profile) return tracks
  const genres = profile.genres.map((g) => g.trim().toLowerCase()).filter(Boolean)
  const filtered = tracks.filter((t) => {
    if (genres.length) {
      // genere del file e generi di MusicBrainz insieme
      const g = `${t.genre}, ${t.mbGenres}`.toLowerCase()
      if (!genres.some((x) => g.includes(x))) return false
    }
    if (profile.yearFrom != null && (t.year == null || t.year < profile.yearFrom)) return false
    if (profile.yearTo != null && (t.year == null || t.year > profile.yearTo)) return false
    return true
  })
  return filtered.length >= 10 ? filtered : tracks
}

/** Riempie la coda automatica: musica con separazioni + un jingle ogni N brani. */
export class RotationService {
  private musicSinceJingle = 0
  private lastJingleId: number | null = null

  constructor(
    private db: RadioDb,
    private now: () => Date = () => new Date()
  ) {}

  fill(upcoming: { track: Track; at: Date }[], count: number): Track[] {
    const s = this.db.getSettings()
    const profile = s.rotationProfile
    const rules: RotationRules = {
      artistSeparationMinutes: profile?.artistSeparationMinutes ?? s.artistSeparationMinutes,
      titleSeparationMinutes: s.titleSeparationMinutes,
      jingleEvery: profile?.jingleEvery ?? s.jingleEvery
    }
    const music = applyProfile(this.db.rotationCandidates('music'), profile)
    const jingles = rules.jingleEvery > 0 ? this.db.rotationCandidates('jingle') : []
    const lookback = Math.max(rules.artistSeparationMinutes, rules.titleSeparationMinutes)
    const recent = this.db.recentPlays(new Date(this.now().getTime() - lookback * 60_000))
    const planned = [...upcoming]
    let at = planned.length ? planned[planned.length - 1].at : this.now()
    const out: Track[] = []

    for (let i = 0; i < count; i++) {
      let next: Track | null = null
      if (jingles.length && this.musicSinceJingle >= rules.jingleEvery) {
        next = pickJingle(jingles, this.lastJingleId)
        if (next) {
          this.lastJingleId = next.id
          this.musicSinceJingle = 0
        }
      }
      if (!next) {
        next = pickMusic(music, recent, planned, at, rules)
        if (next) this.musicSinceJingle++
      }
      if (!next) break
      out.push(next)
      planned.push({ track: next, at })
      at = new Date(at.getTime() + Math.max(1, (next.mixPoint || next.duration) - next.cueIn) * 1000)
    }
    return out
  }
}
