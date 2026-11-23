import type { RadioDb } from './db'
import { DEFAULT_ENERGY_JUMP, pickJingle, pickMusic, sameTempo, type RotationRules } from './rotation'
import { genreText } from './aiRotation'
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
      // genere del file e generi dei servizi (MusicBrainz, Discogs, Last.fm) insieme
      const g = genreText(t).toLowerCase()
      if (!genres.some((x) => g.includes(x))) return false
    }
    if (profile.yearFrom != null && (t.year == null || t.year < profile.yearFrom)) return false
    if (profile.yearTo != null && (t.year == null || t.year > profile.yearTo)) return false
    return true
  })
  return filtered.length >= 10 ? filtered : tracks
}

/** Fascia di energia del profilo (1-10), null se non impostata. */
export function profileEnergy(p: RotationProfile | null): { min: number; max: number } | null {
  if (!p || (p.energyMin == null && p.energyMax == null)) return null
  let min = Math.max(1, Math.min(10, p.energyMin ?? 1))
  let max = Math.max(1, Math.min(10, p.energyMax ?? 10))
  if (min > max) [min, max] = [max, min]
  return { min, max }
}

/** Con il Mix DJ acceso, dopo quanti brani sullo stesso tempo si cambia tempo (a caso tra i due valori). */
export const TEMPO_CHANGE_AFTER = { min: 4, max: 6 }

/** Riempie la coda automatica: musica con separazioni + un jingle ogni N brani. */
export class RotationService {
  private musicSinceJingle = 0
  private lastJingleId: number | null = null
  /** Brani di fila sullo stesso tempo e dopo quanti cambiarlo. */
  private sameTempoRun = 0
  private tempoChangeAt: number

  constructor(
    private db: RadioDb,
    private now: () => Date = () => new Date(),
    private random: () => number = Math.random
  ) {
    this.tempoChangeAt = this.nextTempoChange()
  }

  private nextTempoChange(): number {
    const { min, max } = TEMPO_CHANGE_AFTER
    return min + Math.floor(this.random() * (max - min + 1))
  }

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
    // ultimo brano di musica (in coda, oppure l'ultimo andato in onda): serve per BPM, tonalità ed energia
    let prev: Track | null = [...planned].reverse().find((p) => p.track.kind === 'music')?.track ?? null
    if (!prev) {
      const last = recent.filter((r) => r.trackId != null).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      for (const r of last.slice(0, 5)) {
        const t = this.db.getTrack(r.trackId!)
        if (t?.kind === 'music') {
          prev = t
          break
        }
      }
    }

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
        next = pickMusic(music, recent, planned, at, rules, this.random, {
          prev,
          djMix: s.djMix,
          maxStretch: s.djMaxStretch,
          maxEnergyJump: DEFAULT_ENERGY_JUMP,
          energyRange: profileEnergy(profile),
          tempoChange: s.djMix && this.sameTempoRun + 1 >= this.tempoChangeAt
        })
        if (next) {
          this.musicSinceJingle++
          if (prev && sameTempo(prev, next, s.djMaxStretch)) this.sameTempoRun++
          else {
            this.sameTempoRun = 0
            this.tempoChangeAt = this.nextTempoChange()
          }
          prev = next
        }
      }
      if (!next) break
      out.push(next)
      planned.push({ track: next, at })
      at = new Date(at.getTime() + Math.max(1, (next.mixPoint || next.duration) - next.cueIn) * 1000)
    }
    return out
  }
}
