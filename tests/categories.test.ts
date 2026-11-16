import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyProfile } from '../src/core/rotationService'
import { RadioDb } from '../src/core/db'

const base = { kind: 'music' as const, size: 1, mtime: 1, album: '', year: null, duration: 200, bitrate: 320, sampleRate: 44100, composer: '', publisher: '', isrc: '' }

describe('categorie ed etichette tue', () => {
  it('conta le categorie di tutte le fonti, mette e toglie le etichette, filtra la ricerca', () => {
    const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'cat-')), 'r.db'))
    const a = db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'A', artist: 'X', genre: 'Pop' })
    const b = db.upsertScanned({ ...base, path: '/m/b.mp3', title: 'B', artist: 'Y', genre: 'Rock' })
    db.upsertScanned({ ...base, path: '/m/j.mp3', title: 'J', artist: '', genre: 'Pop', kind: 'jingle' })
    db.saveMb(b, 'r', { genres: ['pop rock'] })
    expect(db.categories()).toEqual([
      { name: 'pop', count: 1, mine: false },
      { name: 'pop rock', count: 1, mine: false },
      { name: 'rock', count: 1, mine: false }
    ])
    expect(db.setUserTag([a, b], '  Da Ballare ', true)).toBe(2)
    expect(db.setUserTag([a], 'da ballare', true)).toBe(0)
    expect(db.getTrack(a)!.userTags).toBe('da ballare')
    expect(db.categories()[0]).toEqual({ name: 'da ballare', count: 2, mine: true })
    expect(db.searchTracks({ category: 'ballare' }).tracks.map((t) => t.title)).toEqual(['A', 'B'])
    expect(db.searchTracks({ category: 'rock' }).tracks.map((t) => t.title)).toEqual(['B'])
    // le etichette valgono nelle regole di rotazione
    const all = db.rotationCandidates('music')
    const many = Array.from({ length: 12 }, () => all).flat()
    expect(new Set(applyProfile(many, { name: 'p', genres: ['da ballare'], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null }).map((t) => t.title))).toEqual(new Set(['A', 'B']))
    expect(db.setUserTag([b], 'da ballare', false)).toBe(1)
    expect(db.getTrack(b)!.userTags).toBe('')
    expect(db.updateTrack(a, { userTags: 'estate, mattina' })!.userTags).toBe('estate, mattina')
    expect(db.listGenres()).toContain('estate')
    db.close()
  })
})
