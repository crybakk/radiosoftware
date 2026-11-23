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

  it('con il Mix DJ acceso ogni 4-6 brani sullo stesso tempo ne sceglie uno con un tempo diverso', () => {
    const db = new RadioDb(':memory:')
    for (let i = 0; i < 40; i++) {
      const id = add(db, i, 'music', `A${i}`)
      db.saveAnalysis(id, { duration: 200, loudness: -14, cueIn: 0.5, cueOut: 199, mixPoint: 195 })
      // metà a 124 BPM, metà a 100: tutti mixabili tra loro per tonalità ed energia
      db.saveDj(id, { bpm: i % 2 ? 100 : 124, firstDownbeat: 1, gridConfidence: 0.95, key: '8A', energy: 5, introEnd: 20, outroStart: 170 })
    }
    db.saveSettings({ djMix: true, jingleEvery: 0 })
    let seed = 3
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const tracks = new RotationService(db, () => new Date('2026-11-16T10:00:00Z'), rnd).fill([], 30)
    const bpm = tracks.map((t) => t.dj!.bpm)
    const runs: number[] = []
    let run = 1
    for (let i = 1; i < bpm.length; i++) {
      if (bpm[i] === bpm[i - 1]) run++
      else {
        runs.push(run)
        run = 1
      }
    }
    // il primo gruppo parte senza brano precedente: conta un brano in più
    expect(runs.length).toBeGreaterThanOrEqual(4)
    expect(Math.max(...runs, run)).toBeLessThanOrEqual(7)
    expect(Math.min(...runs.slice(1))).toBeGreaterThanOrEqual(4)
    db.close()
  })

  it('con il Mix DJ spento non forza cambi di tempo', () => {
    const db = new RadioDb(':memory:')
    for (let i = 0; i < 10; i++) {
      const id = add(db, i, 'music', `A${i}`)
      db.saveAnalysis(id, { duration: 200, loudness: -14, cueIn: 0.5, cueOut: 199, mixPoint: 195 })
      db.saveDj(id, { bpm: 124, firstDownbeat: 1, gridConfidence: 0.95, key: '8A', energy: 5, introEnd: 20, outroStart: 170 })
    }
    expect(new RotationService(db).fill([], 10)).toHaveLength(10)
    db.close()
  })
})
