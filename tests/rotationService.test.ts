import { describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import { RotationService } from '../src/core/rotationService'

function add(db: RadioDb, i: number, kind: 'music' | 'jingle', artist: string) {
  return db.upsertScanned({
    path: `/${kind}/${i}.mp3`, kind, size: 1, mtime: 1, title: `T${i}`, artist, album: '', year: null, genre: '',
    composer: '', publisher: '', isrc: '', duration: 200, bitrate: 192, sampleRate: 44100
  })
}

describe('servizio di rotazione', () => {
  it('alterna musica e jingle e non ripete artisti vicini', () => {
    const db = new RadioDb(':memory:')
    for (let i = 0; i < 20; i++) add(db, i, 'music', `Artista ${i}`)
    add(db, 100, 'jingle', 'Radio')
    add(db, 101, 'jingle', 'Radio')
    db.saveSettings({ jingleEvery: 3 })
    const svc = new RotationService(db, () => new Date('2026-11-16T10:00:00Z'))
    const tracks = svc.fill([], 12)
    expect(tracks.map((t) => t.kind)).toEqual([
      'music', 'music', 'music', 'jingle', 'music', 'music', 'music', 'jingle', 'music', 'music', 'music', 'jingle'
    ])
    const artists = tracks.filter((t) => t.kind === 'music').map((t) => t.artist)
    expect(new Set(artists).size).toBe(artists.length)
    db.close()
  })

  it('senza jingle suona solo musica', () => {
    const db = new RadioDb(':memory:')
    for (let i = 0; i < 5; i++) add(db, i, 'music', `A${i}`)
    const tracks = new RotationService(db).fill([], 6)
    expect(tracks).toHaveLength(6)
    expect(tracks.every((t) => t.kind === 'music')).toBe(true)
    db.close()
  })
})
