import { describe, expect, it } from 'vitest'
import { PlayoutEngine, type AudioBackend, type EngineStep, type Player, type PlayoutHost } from '../src/core/playout'
import type { EventAction, ScheduledEvent, Track } from '../src/core/types'
import { FakeBackend, FakeClock, FakePlayer, makeTrack } from './helpers'

function makeEvent(actions: EventAction[], p: Partial<ScheduledEvent> = {}): ScheduledEvent {
  return {
    id: 1, label: 'Ev', time: '10:00', days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null, validFrom: null,
    validTo: null, mode: 'soft', toleranceSeconds: 0, actions, enabled: true, ...p
  }
}

/** Lettore che resta "in caricamento" finché il test non chiama release(). */
class SlowPlayer extends FakePlayer {
  release!: () => void
  async start(): Promise<void> {
    await new Promise<void>((r) => (this.release = r))
    await super.start()
  }
}

class SlowBackend implements AudioBackend {
  players: SlowPlayer[] = []
  constructor(private clock: FakeClock) {}
  createPlayer(t: Track, g: number): Player {
    const p = new SlowPlayer(t, g, this.clock)
    this.players.push(p)
    return p
  }
}

function setup(pool: Track[], clock = new FakeClock()) {
  const backend = new FakeBackend(clock)
  let poolIdx = 0
  let expanded = 0
  const host: PlayoutHost = {
    fillQueue: async (_up, count) => {
      const out: Track[] = []
      for (let i = 0; i < count && pool.length; i++) out.push(pool[poolIdx++ % pool.length])
      return out
    },
    logStart: async () => 1,
    logEnd: async () => {},
    expandEvent: async (event) => {
      expanded++
      return event.actions.map((a): EngineStep => {
        if (a.type === 'play') return { kind: 'tracks', tracks: [pool.find((t) => t.id === a.trackId)!], placement: 'front' }
        if (a.type === 'clear') return { kind: 'clear' }
        if (a.type === 'stop') return { kind: 'stop' }
        return { kind: 'error', message: 'non gestito' }
      })
    }
  }
  const engine = new PlayoutEngine(backend, host, { crossfadeSeconds: 3, targetLoudness: -16, autoQueueLength: 3 }, clock.now)
  const run = async (seconds: number, step = 0.25) => {
    for (let t = 0; t < seconds; t += step) {
      clock.advance(step)
      backend.settle()
      await engine.tick()
    }
  }
  return { clock, backend, engine, run, expandedCount: () => expanded }
}

const mk = (p: Partial<Track> = {}) => makeTrack({ cueIn: 0, mixPoint: 20, cueOut: 24, duration: 25, ...p })

describe('tolleranza degli eventi soft', () => {
  it('la scadenza non taglia il secondo brano dello stesso evento', async () => {
    const a = mk(), e1 = mk(), e2 = mk()
    const { engine, backend, run } = setup([a, e1, e2])
    engine.enqueue(a)
    await engine.play()
    await run(2)
    // evento soft con due brani e 30 s di tolleranza: A arriva al mix a t=20, l'evento parte in tempo
    await engine.runEvent(makeEvent([{ type: 'play', trackId: e1.id }, { type: 'play', trackId: e2.id }], { toleranceSeconds: 30 }))
    await run(19)
    const pe1 = backend.players.find((p) => p.track.id === e1.id)!
    expect(pe1.startedAt).not.toBeNull()
    await run(12) // passa l'orario limite (t=32) mentre e1 è a metà
    expect(pe1.fadingFor).toBeNull()
  })

  it('"svuota coda" cancella la scadenza: un evento successivo senza tolleranza aspetta la fine del brano', async () => {
    const a = mk({ mixPoint: 200, cueOut: 200, duration: 200 }), e1 = mk(), e2 = mk()
    const { engine, backend, run } = setup([a, e1, e2])
    engine.enqueue(a)
    await engine.play()
    await engine.runEvent(makeEvent([{ type: 'play', trackId: e1.id }], { toleranceSeconds: 30 }))
    engine.clearQueue()
    await run(5)
    await engine.runEvent(makeEvent([{ type: 'play', trackId: e2.id }], { toleranceSeconds: 0 }))
    await run(30)
    expect(backend.players[0].fadingFor).toBeNull()
    expect(engine.snapshot().queue[0].track.id).toBe(e2.id)
  })

  it('STOP cancella la scadenza', async () => {
    const a = mk({ mixPoint: 200, cueOut: 200, duration: 200 }), b = mk({ mixPoint: 200, cueOut: 200, duration: 200 }), e1 = mk()
    const { engine, backend, run } = setup([a, b, e1])
    engine.enqueue(a)
    await engine.play()
    await engine.runEvent(makeEvent([{ type: 'play', trackId: e1.id }], { toleranceSeconds: 10 }))
    engine.stop()
    await run(2)
    // l'operatore toglie l'evento e manda un altro brano: la vecchia scadenza non lo deve tagliare
    engine.remove(engine.snapshot().queue[0].uid)
    engine.enqueue(b)
    await engine.play()
    engine.enqueue(e1, 0, 'event')
    await run(15)
    const pb = backend.players.find((p) => p.track.id === b.id)!
    expect(pb.fadingFor).toBeNull()
  })
})

describe('STOP', () => {
  it('non fa ripartire un evento in coda a fine sfumatura', async () => {
    const a = mk(), e1 = mk()
    const { engine, backend, run } = setup([a, e1])
    engine.enqueue(a)
    await engine.play()
    await run(2)
    await engine.runEvent(makeEvent([{ type: 'play', trackId: e1.id }])) // soft, aspetta A
    engine.stop()
    await run(3)
    expect(engine.snapshot().onAir).toHaveLength(0)
    expect(backend.players).toHaveLength(1)
    // l'evento resta in coda e parte quando la regia preme play
    await engine.play()
    expect(engine.snapshot().onAir[0].track.id).toBe(e1.id)
  })

  it('"Ferma tutto" seguito da brani nello stesso evento: i brani partono dopo la sfumatura', async () => {
    const a = mk(), e1 = mk()
    const { engine, backend, run } = setup([a, e1])
    engine.enqueue(a)
    await engine.play()
    await run(2)
    await engine.runEvent(makeEvent([{ type: 'stop' }, { type: 'play', trackId: e1.id }]))
    expect(backend.players[0].fadingFor).toBe(1)
    await run(1)
    expect(engine.snapshot().onAir.at(-1)!.track.id).toBe(e1.id)
  })

  it('premuto mentre il brano successivo sta caricando: il brano non va in onda e torna in coda', async () => {
    const clock = new FakeClock()
    const be = new SlowBackend(clock)
    const host: PlayoutHost = { fillQueue: async () => [], logStart: async () => 1, logEnd: async () => {}, expandEvent: async () => [] }
    const engine = new PlayoutEngine(be, host, { crossfadeSeconds: 3, targetLoudness: -16, autoQueueLength: 3 }, clock.now)
    const a = mk(), b = mk()
    engine.enqueue(a)
    engine.enqueue(b)
    const p1 = engine.play()
    be.players[0].release()
    await p1
    const pNext = engine.next() // AVANTI: b sta caricando
    engine.stop() // STOP nel frattempo
    be.players[1].release()
    await pNext
    const s = engine.snapshot()
    expect(s.mode).toBe('manual')
    expect(s.onAir.filter((o) => !o.fading)).toHaveLength(0)
    expect(be.players[1].stopped).toBe(true)
    expect(s.queue.map((q) => q.track.id)).toEqual([b.id])
  })
})

describe('brani di durata sconosciuta', () => {
  it('non fanno partire il successivo in base alla posizione ma solo quando finiscono', async () => {
    const unknown = mk({ duration: 0, cueOut: 0, mixPoint: 0 })
    const b = mk(), c = mk()
    const { engine, backend, clock } = setup([unknown, b, c])
    engine.setMode('auto')
    engine.enqueue(unknown, 0)
    // il WebPlayer suona un file con cueOut 0 fino alla fine naturale: niente settle()
    for (let i = 0; i < 40; i++) {
      clock.advance(0.25)
      await engine.tick()
    }
    expect(backend.players.map((p) => p.track.id)).toEqual([unknown.id])
    expect(engine.snapshot().queue.length).toBeGreaterThan(0)
    backend.players[0].end()
    await engine.tick()
    expect(backend.players).toHaveLength(2)
    expect(engine.snapshot().onAir).toHaveLength(1)
  })

  it('in automatico con brani tutti non analizzati ne suona uno alla volta', async () => {
    const pool = [1, 2, 3, 4, 5].map(() => mk({ duration: 0, cueOut: 0, mixPoint: 0 }))
    const { engine, backend, clock } = setup(pool)
    engine.setMode('auto')
    for (let k = 0; k < 10; k++) {
      clock.advance(0.2)
      await engine.tick()
    }
    const live = backend.players.filter((p) => p.startedAt != null && !p.stopped && p.fadingFor == null)
    expect(live).toHaveLength(1)
  })
})

describe('orologio', () => {
  it('se l\'orologio torna indietro un evento già eseguito non scatta di nuovo', async () => {
    const clock = new FakeClock(new Date(2026, 10, 16, 9, 59, 50))
    const jingle = mk()
    const { engine, run, expandedCount } = setup([jingle], clock)
    engine.setEvents([makeEvent([{ type: 'play', trackId: jingle.id }], { time: '10:00' })])
    await run(15) // attraversa le 10:00
    expect(expandedCount()).toBe(1)
    clock.advance(-30) // l'orologio del PC viene corretto all'indietro
    await run(40)
    expect(expandedCount()).toBe(1)
  })
})
