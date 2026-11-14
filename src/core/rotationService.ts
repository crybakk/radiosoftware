import type { RadioDb } from './db'
import { pickJingle, pickMusic, type RotationRules } from './rotation'
import type { Track } from './types'

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
    const rules: RotationRules = {
      artistSeparationMinutes: s.artistSeparationMinutes,
      titleSeparationMinutes: s.titleSeparationMinutes,
      jingleEvery: s.jingleEvery
    }
    const music = this.db.rotationCandidates('music')
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
