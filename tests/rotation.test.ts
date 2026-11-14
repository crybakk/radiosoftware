import { describe, expect, it } from 'vitest'
import { airTime, pickJingle, pickMusic } from '../src/core/rotation'
import { makeTrack } from './helpers'

const rules = { artistSeparationMinutes: 60, titleSeparationMinutes: 180, jingleEvery: 4 }
const at = new Date('2026-11-16T10:00:00Z')

describe('rotazione', () => {
  it('rispetta la separazione artista', () => {
    const a = makeTrack({ artist: 'Vasco' })
    const b = makeTrack({ artist: 'Mina' })
    const recent = [{ trackId: 999, artist: 'vasco ', startedAt: '2026-11-16T09:30:00Z' }]
    for (let i = 0; i < 20; i++) expect(pickMusic([a, b], recent, [], at, rules)!.id).toBe(b.id)
  })

  it('considera anche i brani già in coda', () => {
    const a = makeTrack({ artist: 'Vasco' })
    const b = makeTrack({ artist: 'Mina' })
    const upcoming = [{ track: makeTrack({ artist: 'Mina' }), at: new Date('2026-11-16T09:57:00Z') }]
    expect(pickMusic([a, b], [], upcoming, at, rules)!.id).toBe(a.id)
  })

  it('rilassa le regole invece di restare muta', () => {
    const a = makeTrack({ artist: 'Vasco' })
    const recent = [{ trackId: a.id, artist: 'Vasco', startedAt: '2026-11-16T09:50:00Z' }]
    expect(pickMusic([a], recent, [], at, rules)!.id).toBe(a.id)
  })

  it('preferisce i brani che non vanno in onda da più tempo', () => {
    const tracks = Array.from({ length: 6 }, (_, i) => makeTrack({ artist: `A${i}` }))
    const recent = tracks.slice(0, 4).map((t, i) => ({
      trackId: t.id,
      artist: 'x',
      startedAt: new Date(at.getTime() - (200 + i) * 60_000).toISOString()
    }))
    const picked = pickMusic(tracks, recent, [], at, rules, () => 0.99)!
    expect([tracks[4].id, tracks[5].id]).toContain(picked.id)
  })

  it('jingle diverso dall\'ultimo', () => {
    const j1 = makeTrack({ kind: 'jingle' })
    const j2 = makeTrack({ kind: 'jingle' })
    for (let i = 0; i < 10; i++) expect(pickJingle([j1, j2], j1.id)!.id).toBe(j2.id)
  })

  it('durata in onda usa inizio e punto di mix', () => {
    expect(airTime(makeTrack({ cueIn: 2, mixPoint: 170, cueOut: 178 }))).toBe(168)
  })
})
