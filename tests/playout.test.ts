import { beforeEach, describe, expect, it } from 'vitest'
import { PlayoutEngine, type PlayoutHost } from '../src/core/playout'
import type { Track } from '../src/core/types'
import { FakeBackend, FakeClock, makeTrack } from './helpers'

function setup(pool: Track[] = []) {
  const clock = new FakeClock()
  const backend = new FakeBackend(clock)
  const log: { id: number; track: Track; start: Date; end?: Date; seconds?: number }[] = []
  let poolIdx = 0
  const host: PlayoutHost = {
    fillQueue: async (_up, count) => {
      const out: Track[] = []
      for (let i = 0; i < count && pool.length; i++) out.push(pool[poolIdx++ % pool.length])
      return out
    },
    logStart: async (track, at) => {
      log.push({ id: log.length + 1, track, start: at })
      return log.length
    },
    logEnd: async (id, at, seconds) => {
      log[id - 1].end = at
      log[id - 1].seconds = seconds
    },
    resolveTrack: async (id) => pool.find((t) => t.id === id) ?? null
  }
  const engine = new PlayoutEngine(backend, host, { crossfadeSeconds: 3, targetLoudness: -16, autoQueueLength: 3 }, clock.now)
  const run = async (seconds: number, step = 0.25) => {
    for (let t = 0; t < seconds; t += step) {
      clock.advance(step)
      backend.settle()
      await engine.tick()
    }
  }
  return { clock, backend, engine, log, run }
}

describe('motore di messa in onda', () => {
  let pool: Track[]
  beforeEach(() => {
    pool = [1, 2, 3, 4].map((i) => makeTrack({ cueIn: 1, mixPoint: 20, cueOut: 24, duration: 25, artist: `A${i}` }))
  })

  it('in manuale suona solo quando premi play e si ferma a fine brano', async () => {
    const { engine, backend, run, log } = setup(pool)
    engine.enqueue(pool[0])
    engine.enqueue(pool[1])
    await run(2)
    expect(backend.players).toHaveLength(0)
    await engine.play()
    expect(engine.snapshot().onAir[0].track.id).toBe(pool[0].id)
    await run(30)
    expect(engine.snapshot().onAir).toHaveLength(0)
    expect(engine.snapshot().queue).toHaveLength(1)
    expect(log).toHaveLength(1)
    expect(log[0].seconds).toBeGreaterThan(22)
  })

  it('in automatico riempie la coda e incrocia i brani al punto di mix', async () => {
    const { engine, backend, run, log } = setup(pool)
    engine.setMode('auto')
    await run(1)
    expect(backend.players).toHaveLength(1)
    expect(engine.snapshot().queue.length).toBeGreaterThanOrEqual(3)
    await run(19.5) // posizione ~ 20.5 > punto di mix 20 (inizio da 1)
    expect(backend.players).toHaveLength(2)
    // per qualche secondo due brani in onda insieme (dissolvenza)
    expect(engine.snapshot().onAir.length).toBe(2)
    await run(60)
    expect(log.length).toBeGreaterThanOrEqual(4)
    expect(engine.snapshot().onAir.length).toBeGreaterThanOrEqual(1)
  })

  it('applica il guadagno di livellamento', async () => {
    const { engine, backend } = setup()
    engine.enqueue(makeTrack({ loudness: -10 }))
    await engine.play()
    expect(backend.players[0].gainDb).toBe(-6)
  })

  it('AVANTI sfuma il brano in onda e parte il successivo', async () => {
    const { engine, backend } = setup()
    engine.enqueue(pool[0])
    engine.enqueue(pool[1])
    await engine.play()
    await engine.next()
    expect(backend.players[0].fadingFor).toBe(3)
    expect(engine.snapshot().onAir.at(-1)!.track.id).toBe(pool[1].id)
  })

  it('STOP sfuma e passa in manuale', async () => {
    const { engine, backend, run } = setup(pool)
    engine.setMode('auto')
    await run(1)
    engine.stop()
    expect(engine.getMode()).toBe('manual')
    expect(backend.players[0].fadingFor).toBe(1)
    await run(5)
    expect(engine.snapshot().onAir).toHaveLength(0)
  })

  it('salta un file che non si riesce a leggere', async () => {
    const { engine, backend } = setup()
    const broken = makeTrack()
    backend.failPaths.add(broken.path)
    engine.enqueue(broken)
    engine.enqueue(pool[0])
    await engine.play()
    expect(engine.snapshot().onAir[0].track.id).toBe(pool[0].id)
  })

  it('evento "hard" interrompe all\'orario esatto', async () => {
    const { engine, backend, clock, run } = setup(pool)
    const jingle = makeTrack({ kind: 'jingle', duration: 5, cueOut: 5, mixPoint: 5 })
    pool.push(jingle)
    const at = new Date(clock.t + 3000)
    engine.setEvents([
      { id: 1, time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`, days: [0, 1, 2, 3, 4, 5, 6], trackId: jingle.id, mode: 'hard', enabled: true, label: 'Sigla' }
    ])
    // porta l'orologio poco prima del minuto dell'evento
    clock.t = new Date(at).setSeconds(0, 0) - 2000
    engine.enqueue(pool[0])
    await engine.play()
    await run(3)
    expect(engine.snapshot().onAir.at(-1)!.track.id).toBe(jingle.id)
    expect(backend.players[0].fadingFor).toBe(3)
  })

  it('evento "soft" in manuale parte a fine brano', async () => {
    const { engine, clock, run, backend } = setup(pool)
    const jingle = makeTrack({ kind: 'jingle', duration: 5, cueOut: 5, mixPoint: 5 })
    pool.push(jingle)
    const minute = new Date(clock.t + 60_000)
    minute.setSeconds(0, 0)
    clock.t = minute.getTime() - 2000
    engine.setEvents([
      { id: 1, time: `${String(minute.getHours()).padStart(2, '0')}:${String(minute.getMinutes()).padStart(2, '0')}`, days: [0, 1, 2, 3, 4, 5, 6], trackId: jingle.id, mode: 'soft', enabled: true, label: '' }
    ])
    engine.enqueue(pool[0])
    await engine.play()
    await run(5)
    expect(engine.snapshot().onAir[0].track.id).toBe(pool[0].id)
    expect(engine.snapshot().queue[0].track.id).toBe(jingle.id)
    await run(16) // il brano arriva al punto di mix (20 s): parte l'evento anche se in manuale
    expect(backend.players.at(-1)!.track.id).toBe(jingle.id)
  })

  it('la cartwall suona sopra senza toccare la coda', async () => {
    const { engine } = setup()
    engine.enqueue(pool[0])
    await engine.play()
    await engine.playCart(makeTrack({ kind: 'jingle' }))
    const s = engine.snapshot()
    expect(s.carts).toHaveLength(1)
    expect(s.onAir).toHaveLength(1)
  })
})
