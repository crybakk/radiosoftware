import { describe, expect, it } from 'vitest'
import { planMix, tempoRatio, type MixPlan } from '../src/core/djMix'
import type { DjAnalysis } from '../src/core/djAnalysis'
import { PlayoutEngine, type PlayoutHost } from '../src/core/playout'
import type { Track } from '../src/core/types'
import { FakeBackend, FakeClock, FakePlayer, makeTrack } from './helpers'

const BAR_124 = (4 * 60) / 124

/** Brano a 124 BPM: primo "uno" a 1 s, intro di `intro` battute, outro di `outro` battute, `bars` battute in tutto. */
function djTrack(p: { bpm?: number; intro?: number; outro?: number; bars?: number; dj?: Partial<DjAnalysis>; t?: Partial<Track> } = {}): Track {
  const bpm = p.bpm ?? 124
  const bar = (4 * 60) / bpm
  const bars = p.bars ?? 96
  const first = 1
  const end = first + bars * bar
  return makeTrack({
    cueIn: 0.5,
    cueOut: end,
    duration: end + 1,
    mixPoint: end - 5,
    dj: {
      bpm,
      firstDownbeat: first,
      gridConfidence: 0.98,
      key: '8A',
      energy: 7,
      introEnd: first + (p.intro ?? 16) * bar,
      outroStart: first + (bars - (p.outro ?? 16)) * bar,
      ...p.dj
    },
    ...p.t
  })
}

describe('piano del Mix DJ', () => {
  it('outro lungo: mix di 16 battute che parte all\'inizio dell\'outro, senza loop', () => {
    const a = djTrack({ outro: 16 })
    const b = djTrack({ intro: 16 })
    const d = planMix(a, b)
    expect(d.ok).toBe(true)
    const plan = (d as { plan: MixPlan }).plan
    expect(plan.bars).toBe(16)
    expect(plan.loop).toBeNull()
    expect(plan.aStart).toBeCloseTo(1 + 80 * BAR_124, 2)
    expect(plan.bStart).toBe(1)
    expect(plan.rate).toBe(1)
    expect(plan.seconds).toBeCloseTo(16 * BAR_124, 2)
    expect(plan.bassSwapAt).toBeCloseTo(8 * BAR_124, 2)
  })

  it('outro corto: loop delle ultime 4 battute piene prima dell\'outro', () => {
    const a = djTrack({ outro: 2 })
    const b = djTrack({ intro: 16 })
    const plan = (planMix(a, b) as { plan: MixPlan }).plan
    expect(plan.loop).not.toBeNull()
    expect(plan.loop!.end).toBeCloseTo(1 + 94 * BAR_124, 2)
    expect(plan.loop!.start).toBeCloseTo(1 + 90 * BAR_124, 2)
    expect(plan.aStart).toBeCloseTo(plan.loop!.start, 3)
  })

  it('intro corta: mix di 8 battute', () => {
    const plan = (planMix(djTrack({ outro: 16 }), djTrack({ intro: 0 })) as { plan: MixPlan }).plan
    expect(plan.bars).toBe(8)
    // l'outro di 16 battute avanza di 8: il mix finisce con la fine dell'outro
    expect(plan.aStart).toBeCloseTo(1 + 88 * BAR_124, 2)
  })

  it('tempi vicini: il brano che entra si adatta; metà e doppio contano', () => {
    const plan = (planMix(djTrack({ bpm: 124 }), djTrack({ bpm: 120 })) as { plan: MixPlan }).plan
    expect(plan.rate).toBeCloseTo(124 / 120, 3)
    expect(tempoRatio(128, 64)).toBe(1)
    expect(tempoRatio(85, 170)).toBe(1)
  })

  it('tempi troppo diversi, ritmo irregolare, analisi mancante o non musica: dissolvenza normale', () => {
    const r1 = planMix(djTrack({ bpm: 124 }), djTrack({ bpm: 100 }))
    expect(r1).toMatchObject({ ok: false })
    expect((r1 as { reason: string }).reason).toMatch(/tempi troppo diversi/)
    expect(planMix(djTrack(), djTrack({ dj: { gridConfidence: 0.3 } })).ok).toBe(false)
    expect(planMix(djTrack(), makeTrack()).ok).toBe(false)
    expect(planMix(djTrack(), djTrack({ t: { kind: 'jingle' } })).ok).toBe(false)
    // con un limite più largo si mixa
    expect(planMix(djTrack({ bpm: 124 }), djTrack({ bpm: 110 }), 0.15).ok).toBe(true)
  })
})

class MixBackend extends FakeBackend {
  mixes: { from: FakePlayer; to: FakePlayer; plan: MixPlan }[] = []
  fail = false
  constructor(private c: FakeClock) {
    super(c)
  }
  async startMix(from: FakePlayer, to: FakePlayer, plan: MixPlan): Promise<void> {
    if (this.fail) throw new Error('decodifica non riuscita')
    this.mixes.push({ from, to, plan })
    // il brano che entra parte da bStart (simulato: inizio = adesso, posizione = cueIn)
    to.startedAt = this.c.t
  }
}

function setup(tracks: Track[]) {
  const clock = new FakeClock()
  const backend = new MixBackend(clock)
  const host: PlayoutHost = {
    fillQueue: async () => [],
    logStart: async () => 1,
    logEnd: async () => {},
    expandEvent: async () => []
  }
  const engine = new PlayoutEngine(backend, host, { crossfadeSeconds: 3, targetLoudness: -16, autoQueueLength: 0 }, clock.now)
  for (const t of tracks) engine.enqueue(t)
  const run = async (seconds: number, step = 0.25): Promise<void> => {
    for (let t = 0; t < seconds; t += step) {
      clock.advance(step)
      await engine.tick()
    }
  }
  return { clock, backend, engine, run }
}

describe('Mix DJ nel motore', () => {
  it('"Mixa il prossimo" in manuale: parte 6 s prima del punto del mix, poi si spegne', async () => {
    const a = djTrack({ outro: 16 })
    const b = djTrack()
    const { engine, backend, run } = setup([a, b])
    await engine.play()
    engine.setDjOnce(true)
    expect(engine.snapshot().dj.next).toMatchObject({ ok: true })
    const aStart = (planMix(a, b) as { plan: MixPlan }).plan.aStart
    // posizione di A = cueIn (0,5) + secondi passati
    await run(aStart - 0.5 - 6 - 0.5)
    expect(backend.mixes).toHaveLength(0)
    await run(1)
    expect(backend.mixes).toHaveLength(1)
    const snap = engine.snapshot()
    expect(snap.dj.once).toBe(false)
    expect(snap.onAir.at(-1)!.track).toBe(b)
    expect(snap.onAir[0]).toMatchObject({ track: a, fading: true })
    expect(snap.dj.mixing).toBe(true)
  })

  it('in manuale senza il pulsante non mixa, anche se il Mix DJ è acceso', async () => {
    const a = djTrack()
    const { engine, backend, run } = setup([a, djTrack()])
    engine.setOptions({ djMix: true })
    await engine.play()
    await run(a.cueOut)
    expect(backend.mixes).toHaveLength(0)
  })

  it('in automatico con il Mix DJ acceso mixa a ogni cambio possibile, gli altri con il punto di mix', async () => {
    const a = djTrack()
    const b = djTrack({ bpm: 90 }) // troppo lento: cambio normale
    const { engine, backend, run } = setup([a, b])
    engine.setOptions({ djMix: true })
    engine.setMode('auto')
    await engine.play()
    expect(engine.snapshot().dj.next).toMatchObject({ ok: false })
    await run(a.mixPoint + 1)
    expect(backend.mixes).toHaveLength(0)
    expect(engine.snapshot().onAir.at(-1)!.track).toBe(b)
  })

  it('se il Mix DJ non riesce il brano resta in coda e vale il cambio normale', async () => {
    const a = djTrack()
    const b = djTrack()
    const { engine, backend, run } = setup([a, b])
    backend.fail = true
    engine.setDjOnce(true)
    engine.setMode('auto')
    await engine.play()
    const aStart = (planMix(a, b) as { plan: MixPlan }).plan.aStart
    await run(aStart - 6)
    expect(engine.snapshot().queue[0].track).toBe(b)
    expect(engine.snapshot().lastError).toMatch(/Mix DJ non riuscito/)
    await run(a.mixPoint - aStart + 7)
    expect(engine.snapshot().onAir.at(-1)!.track).toBe(b)
  })

  it('STOP sfuma anche il brano che sta uscendo con il Mix DJ', async () => {
    const a = djTrack()
    const { engine, backend, run } = setup([a, djTrack()])
    engine.setDjOnce(true)
    await engine.play()
    await run((planMix(a, djTrack()) as { plan: MixPlan }).plan.aStart)
    expect(backend.mixes).toHaveLength(1)
    engine.stop()
    expect(backend.mixes[0].from.fadingFor).toBe(1)
    expect(backend.mixes[0].to.fadingFor).toBe(1)
  })
})

describe('azione "Mix DJ" negli eventi', () => {
  it('accende e spegne il Mix DJ nelle impostazioni, senza passi per il motore', async () => {
    const { RadioDb } = await import('../src/core/db')
    const { expandEvent } = await import('../src/core/eventActions')
    const db = new RadioDb(':memory:')
    expect(db.getSettings().djMix).toBe(false)
    const event = (on: boolean) => ({
      id: 1, label: '', time: '10:00', days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null, validFrom: null,
      validTo: null, mode: 'soft' as const, toleranceSeconds: 0, enabled: true, actions: [{ type: 'djMix' as const, on }]
    })
    expect(await expandEvent(db, event(true), { now: () => new Date(), runCommand: () => {} })).toEqual([])
    expect(db.getSettings().djMix).toBe(true)
    await expandEvent(db, event(false), { now: () => new Date(), runCommand: () => {} })
    expect(db.getSettings().djMix).toBe(false)
    db.close()
  })
})
