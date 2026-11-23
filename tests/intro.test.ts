import { describe, expect, it } from 'vitest'
import { introLeft, introSeconds } from '../src/core/intro'
import { PlayoutEngine } from '../src/core/playout'
import { toRemoteState } from '../src/core/remote'
import { FakeBackend, FakeClock, makeTrack } from './helpers'

const dj = { bpm: 124, firstDownbeat: 1, gridConfidence: 0.98, key: '8A', energy: 7, introEnd: 16.5, outroStart: 180 }

describe('conto alla rovescia dell\'intro', () => {
  it('durata dell\'intro dal punto di partenza del brano', () => {
    expect(introSeconds(makeTrack({ cueIn: 0.5, dj }))).toBe(16)
    // intro troppo corta, analisi mancante, niente ritmo o non musica: nessun conto
    expect(introSeconds(makeTrack({ cueIn: 0.5, dj: { ...dj, introEnd: 2 } }))).toBe(0)
    expect(introSeconds(makeTrack({ cueIn: 0.5 }))).toBe(0)
    expect(introSeconds(makeTrack({ cueIn: 0.5, dj: { ...dj, bpm: 0 } }))).toBe(0)
    expect(introSeconds(makeTrack({ cueIn: 0.5, dj, kind: 'jingle' }))).toBe(0)
  })

  it('quanto manca alla voce, finché l\'intro non è finita', () => {
    const t = makeTrack({ cueIn: 0.5, dj })
    expect(introLeft(t, 0.5)).toBe(16)
    expect(introLeft(t, 10)).toBeCloseTo(6.5, 3)
    expect(introLeft(t, 16.5)).toBeNull()
    expect(introLeft(makeTrack({ cueIn: 0.5 }), 1)).toBeNull()
  })

  it('arriva al pannello: in onda e in coda', async () => {
    const clock = new FakeClock()
    const host = { fillQueue: async () => [], logStart: async () => 1, logEnd: async () => {}, expandEvent: async () => [] }
    const engine = new PlayoutEngine(new FakeBackend(clock), host, { crossfadeSeconds: 2, targetLoudness: -16, autoQueueLength: 0 }, () => clock.now())
    const a = makeTrack({ id: 1, cueIn: 0.5, duration: 200, cueOut: 199, mixPoint: 195, dj })
    const b = makeTrack({ id: 2, cueIn: 0.5, duration: 200, cueOut: 199, mixPoint: 195, dj })
    engine.enqueue(a)
    engine.enqueue(b)
    await engine.play()
    clock.advance(4)
    await engine.tick()
    const s = toRemoteState(engine.snapshot(), [], 'collegato')
    expect(s.onAir!.introLeft).toBeCloseTo(12, 0)
    expect(s.queue[0].intro).toBe(16)
  })
})
