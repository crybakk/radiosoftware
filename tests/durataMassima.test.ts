import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'

const base = { kind: 'music' as const, size: 1, mtime: 1, album: '', year: null, bitrate: 320, sampleRate: 44100, composer: '', publisher: '', isrc: '' }

describe('durata massima dei brani (premixati)', () => {
  it('nasconde la musica troppo lunga ovunque e la fa ricomparire alzando il limite', () => {
    const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'durata-')), 'r.db'))
    db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'Canzone', artist: 'X', genre: 'Pop', duration: 240 })
    db.upsertScanned({ ...base, path: '/m/mix.mp3', title: 'Mix estate', artist: 'DJ', genre: 'Dance', duration: 3600 })
    db.upsertScanned({ ...base, path: '/m/ignota.mp3', title: 'Durata ignota', artist: 'Y', genre: 'Pop', duration: 0 })
    db.upsertScanned({ ...base, path: '/n/tg.mp3', title: 'Notiziario', artist: '', genre: '', duration: 1800, kind: 'news' })

    // predefinito: 10 minuti
    expect(db.getSettings().maxTrackMinutes).toBe(10)
    const titles = (): string[] => db.searchTracks({ text: '' }).tracks.map((t) => t.title).sort()
    expect(titles()).toEqual(['Canzone', 'Durata ignota', 'Notiziario'])
    expect(db.rotationCandidates('music').map((t) => t.title).sort()).toEqual(['Canzone', 'Durata ignota'])
    expect(db.listGenres()).not.toContain('Dance')
    expect(db.categories().map((c) => c.name)).not.toContain('dance')
    expect(db.libraryStats()).toMatchObject({ total: 3, hiddenLong: 1, maxTrackMinutes: 10 })
    for (let i = 0; i < 20; i++) expect(db.randomTrack({ kind: 'music' })?.title).not.toBe('Mix estate')
    expect(db.pendingFingerprint().map((t) => t.title)).not.toContain('Mix estate')
    expect(db.tagPending('dc').map((t) => t.title)).not.toContain('Mix estate')

    // limite alzato (o tolto): il premixato ricompare
    db.saveSettings({ maxTrackMinutes: 0 })
    expect(titles()).toContain('Mix estate')
    expect(db.libraryStats().hiddenLong).toBe(0)
    db.saveSettings({ maxTrackMinutes: 90 })
    expect(db.rotationCandidates('music').map((t) => t.title)).toContain('Mix estate')
  })
})
