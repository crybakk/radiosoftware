import { describe, expect, it } from 'vitest'
import { expandEvent } from '../src/core/eventActions'
import { PlayoutEngine, type PlayoutHost } from '../src/core/playout'
import type { EventAction, ScheduledEvent, Track } from '../src/core/types'
import { FakeBackend, FakeClock, makeTrack } from './helpers'

// Gli annunci con la voce dicono l'ora in cui vanno in onda (dopo il brano in corso),
// non quella in cui scatta l'evento: prima la differenza arrivava a 3-4 minuti.

const event = (actions: EventAction[], p: Partial<ScheduledEvent> = {}): ScheduledEvent => ({
  id: 1, label: '', time: '*:00', days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null, validFrom: null, validTo: null,
  mode: 'soft', toleranceSeconds: 0, actions, enabled: true, ...p
})

describe('annunci della regia: ora in cui vanno in onda', () => {
  it('l\'evento sa quando partirà: alla fine del brano, subito se "interrompe", al massimo dopo la tolleranza', async () => {
    const clock = new FakeClock()
    const backend = new FakeBackend(clock)
    const pool = [1, 2, 3].map((i) => makeTrack({ cueIn: 1, mixPoint: 200, cueOut: 210, duration: 215, artist: `A${i}` }))
    const host: PlayoutHost = {
      fillQueue: async () => [],
      logStart: async () => 1,
      logEnd: async () => {},
      expandEvent: async () => [{ kind: 'tracks', tracks: [pool[2]], placement: 'front' }]
    }
    const engine = new PlayoutEngine(backend, host, { crossfadeSeconds: 3, targetLoudness: -16, autoQueueLength: 3 }, clock.now)
    const now = (): number => clock.now().getTime()
    // regia ferma: subito
    expect(engine.eventStartEstimate(event([])).getTime()).toBe(now())
    engine.enqueue(pool[0])
    await engine.play()
    engine.enqueue(pool[1])
    clock.advance(20)
    backend.settle()
    await engine.tick()
    const toMix = engine.snapshot().onAir[0].toMix
    expect(toMix).toBeGreaterThan(100)
    const endOfTrack = now() + toMix * 1000
    expect(engine.eventStartEstimate(event([])).getTime()).toBe(endOfTrack)
    expect(engine.eventStartEstimate(event([], { mode: 'hard' })).getTime()).toBe(now())
    expect(engine.eventStartEstimate(event([], { toleranceSeconds: 30 })).getTime()).toBe(now() + 30_000)
    // un altro evento già in coda va prima
    await engine.runEvent(event([{ type: 'play', trackId: pool[2].id }]))
    expect(engine.eventStartEstimate(event([])).getTime()).toBe(endOfTrack + 199_000)
    // se l'evento svuota la coda parte dopo il brano in corso
    expect(engine.eventStartEstimate(event([{ type: 'clear' }])).getTime()).toBe(endOfTrack)
  })

  it('l\'annuncio dice l\'ora di partenza più i brani dell\'evento messi prima di lui', async () => {
    const jingle: Track = makeTrack({ id: 7, cueIn: 0, mixPoint: 0, cueOut: 0, duration: 40 })
    const db = { getTrack: (id: number) => (id === 7 ? jingle : null) }
    const asked: Date[] = []
    const startAt = new Date(2026, 10, 26, 23, 3, 30)
    await expandEvent(db as never, event([{ type: 'voice', text: 'Sono le {ora}' }, { type: 'play', trackId: 7 }, { type: 'voice', text: 'Ancora' }]), {
      now: () => new Date(2026, 10, 26, 23, 0, 0),
      startAt,
      runCommand: () => {},
      voice: async (_text, at) => (asked.push(at), { track: makeTrack({ id: -1, cueIn: 0, mixPoint: 0, cueOut: 0, duration: 5 }), note: '' })
    })
    expect(asked.map((d) => d.getTime())).toEqual([startAt.getTime(), startAt.getTime() + 45_000])
  })
})
