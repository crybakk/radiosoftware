import { beforeEach, describe, expect, it } from 'vitest'
import { PlayoutEngine, type EngineStep, type PlayoutHost } from '../src/core/playout'
import type { EventAction, ScheduledEvent } from '../src/core/types'
import type { Track } from '../src/core/types'
import { FakeBackend, FakeClock, makeTrack } from './helpers'

function makeEvent(at: Date, actions: EventAction[], p: Partial<ScheduledEvent> = {}): ScheduledEvent {
  return {
    id: 1, label: '', time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
    days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null, validFrom: null, validTo: null, mode: 'soft',
    toleranceSeconds: 0, actions, enabled: true, ...p
  }
}

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
    expandEvent: async (event) =>
      event.actions.map((a): EngineStep => {
        if (a.type === 'play') return { kind: 'tracks', tracks: [pool.find((t) => t.id === a.trackId)!], placement: 'front' }
        if (a.type === 'mode') return { kind: 'mode', mode: a.mode }
        if (a.type === 'clear') return { kind: 'clear' }
        if (a.type === 'stop') return { kind: 'stop' }
        return { kind: 'error', message: 'non gestito' }
      })
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
    // sfumatura incrociata: il primo sfuma fino alla sua fine (24) mentre parte il secondo
    expect(backend.players[0].fadingFor).toBeGreaterThan(3)
    expect(backend.players[0].fadingFor).toBeLessThanOrEqual(4)
    await run(60)
    expect(log.length).toBeGreaterThanOrEqual(4)
    expect(engine.snapshot().onAir.length).toBeGreaterThanOrEqual(1)
  })

  it('le canzoni che finiscono secche si sovrappongono lo stesso: la successiva parte 4 s prima della fine', async () => {
    const secche = [1, 2, 3].map((i) => makeTrack({ cueIn: 0, mixPoint: 30, cueOut: 30, duration: 30, artist: `S${i}` }))
    const { engine, backend, run } = setup(secche)
    engine.setMode('auto')
    await run(25.5)
    expect(backend.players).toHaveLength(1)
    await run(1) // posizione oltre 26 = 30 - 4
    expect(backend.players).toHaveLength(2)
    expect(backend.players[0].fadingFor).toBeGreaterThan(3.5)
  })

  it('jingle e voci non si accorciano: il successivo parte alla loro fine', async () => {
    const { engine, backend, run } = setup()
    engine.enqueue(makeTrack({ kind: 'jingle', cueIn: 0, mixPoint: 10, cueOut: 10, duration: 10 }))
    engine.enqueue(makeTrack({ artist: 'dopo' }))
    engine.setMode('auto')
    await engine.play()
    await run(9.5)
    expect(backend.players).toHaveLength(1)
    expect(backend.players[0].fadingFor).toBeNull()
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
      makeEvent(at, [{ type: 'play', trackId: jingle.id }], { mode: 'hard', label: 'Sigla' })
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
      makeEvent(minute, [{ type: 'play', trackId: jingle.id }])
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

  it('tolleranza: aspetta al massimo N secondi e poi sfuma', async () => {
    const { engine, backend, run } = setup(pool)
    const jingle = makeTrack({ kind: 'jingle', duration: 5, cueOut: 5, mixPoint: 5 })
    pool.push(jingle)
    engine.enqueue(pool[0])
    await engine.play()
    await run(2)
    await engine.runEvent(makeEvent(new Date(), [{ type: 'play', trackId: jingle.id }], { toleranceSeconds: 4 }))
    expect(engine.snapshot().queue[0].track.id).toBe(jingle.id)
    await run(3)
    expect(backend.players).toHaveLength(1)
    await run(2)
    expect(backend.players.at(-1)!.track.id).toBe(jingle.id)
    expect(backend.players[0].fadingFor).toBe(3)
  })

  it('azioni di controllo: svuota, passa in automatico, sequenza di brani in ordine', async () => {
    const { engine } = setup(pool)
    engine.enqueue(pool[3])
    await engine.runEvent(
      makeEvent(new Date(), [
        { type: 'clear' },
        { type: 'play', trackId: pool[0].id },
        { type: 'play', trackId: pool[1].id },
        { type: 'mode', mode: 'auto' }
      ])
    )
    const s = engine.snapshot()
    expect(engine.getMode()).toBe('auto')
    // la regia era ferma: il primo brano parte subito, il secondo resta in coda
    expect(s.onAir[0].track.id).toBe(pool[0].id)
    expect(s.queue.map((q) => q.track.id)).toEqual([pool[1].id])
  })

  it('azione stop ferma tutto', async () => {
    const { engine, backend } = setup(pool)
    engine.setMode('auto')
    engine.enqueue(pool[0])
    await engine.play()
    await engine.runEvent(makeEvent(new Date(), [{ type: 'stop' }]))
    expect(engine.getMode()).toBe('manual')
    expect(backend.players[0].fadingFor).toBe(1)
  })
})
