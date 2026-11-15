import { describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import { dayStart, logRange } from '../src/renderer/src/logRange'
import { makeTrack } from './helpers'

describe('registro di trasmissione', () => {
  it('alla chiusura del programma il brano in onda resta nel registro con il tempo trasmesso', () => {
    const db = new RadioDb(':memory:')
    db.logStart(makeTrack({ id: -5 }), new Date('2026-11-16T10:00:00Z'))
    db.closeDanglingLog(new Date('2026-11-16T10:02:00Z'))
    const [e] = db.listLog(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'))
    expect(e.endedAt).toBe('2026-11-16T10:02:00.000Z')
    expect(e.playedSeconds).toBeCloseTo(120)
    db.close()
  })

  it('dopo un crash la durata trasmessa non supera quella del brano', () => {
    const db = new RadioDb(':memory:')
    const id = db.upsertScanned({
      path: '/a.mp3', kind: 'music', size: 1, mtime: 1, title: 'A', artist: 'B', album: '', year: null, genre: '',
      composer: '', publisher: '', isrc: '', duration: 200, bitrate: 320, sampleRate: 44100
    })
    db.logStart(db.getTrack(id)!, new Date('2026-11-16T10:00:00Z'))
    db.closeDanglingLog(new Date('2026-11-16T15:00:00Z')) // il programma riparte ore dopo
    const [e] = db.listLog(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'))
    expect(e.playedSeconds).toBe(200)
    db.close()
  })

  it('una data cancellata nel registro non genera errori', () => {
    expect(dayStart('')).toBeNull()
    expect(dayStart('2026-13-')).toBeNull()
    expect(logRange('', '2026-11-15')).toBeNull()
    expect(logRange('2026-11-15', '')).toBeNull()
    const r = logRange('2026-11-15', '2026-11-15')!
    expect(new Date(r[1]).getTime() - new Date(r[0]).getTime()).toBeGreaterThanOrEqual(23 * 3600_000)
    expect(dayStart('2026-11-15')!.getDate()).toBe(15)
  })
})
