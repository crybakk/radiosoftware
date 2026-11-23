import { describe, expect, it } from 'vitest'
import { mixable, pickMusic, preferFlow, type FlowRules } from '../src/core/rotation'
import type { DjAnalysis } from '../src/core/djAnalysis'
import { makeTrack } from './helpers'

const rules = { artistSeparationMinutes: 0, titleSeparationMinutes: 0, jingleEvery: 0 }
const at = new Date('2026-11-23T10:00:00Z')
const dj = (p: Partial<DjAnalysis>): DjAnalysis => ({
  bpm: 124, firstDownbeat: 1, gridConfidence: 0.95, key: '8A', energy: 6, introEnd: 20, outroStart: 170, ...p
})
const flow = (p: Partial<FlowRules>): FlowRules => ({ prev: null, djMix: false, maxStretch: 0.06, maxEnergyJump: 2, ...p })

describe('rotazione: brani mixabili ed energia', () => {
  it('mixabile: BPM entro il limite (anche metà/doppio) e tonalità compatibile', () => {
    const a = makeTrack({ dj: dj({}) })
    expect(mixable(a, makeTrack({ dj: dj({ bpm: 120, key: '9A' }) }), 0.06)).toBe(true)
    expect(mixable(a, makeTrack({ dj: dj({ bpm: 62, key: '8B' }) }), 0.06)).toBe(true)
    expect(mixable(a, makeTrack({ dj: dj({ bpm: 100 }) }), 0.06)).toBe(false)
    expect(mixable(a, makeTrack({ dj: dj({ key: '3B' }) }), 0.06)).toBe(false)
    expect(mixable(a, makeTrack({ dj: dj({ gridConfidence: 0.2 }) }), 0.06)).toBe(false)
    expect(mixable(a, makeTrack(), 0.06)).toBe(false)
  })

  it('con il Mix DJ acceso sceglie un brano mixabile se c\'è', () => {
    const prev = makeTrack({ dj: dj({}) })
    const ok = makeTrack({ dj: dj({ bpm: 126 }) })
    const others = [1, 2, 3, 4, 5].map(() => makeTrack({ dj: dj({ bpm: 90 }) }))
    for (let i = 0; i < 20; i++) {
      expect(pickMusic([...others, ok], [], [], at, rules, Math.random, flow({ prev, djMix: true }))!.id).toBe(ok.id)
    }
  })

  it('se nessuno è mixabile sceglie come sempre', () => {
    const prev = makeTrack({ dj: dj({}) })
    const others = [1, 2].map(() => makeTrack({ dj: dj({ bpm: 90 }) }))
    expect(pickMusic(others, [], [], at, rules, Math.random, flow({ prev, djMix: true }))).not.toBeNull()
  })

  it('energia: niente salti di più di 2 punti, i brani non analizzati passano', () => {
    const prev = makeTrack({ dj: dj({ energy: 3 }) })
    const calmo = makeTrack({ dj: dj({ energy: 4 }) })
    const forte = makeTrack({ dj: dj({ energy: 9 }) })
    const ignoto = makeTrack()
    expect(preferFlow([calmo, forte, ignoto], flow({ prev })).map((t) => t.id)).toEqual([calmo.id, ignoto.id])
    // nessuno vicino: si rinuncia al limite
    expect(preferFlow([forte], flow({ prev }))).toEqual([forte])
  })

  it('l\'energia conta più del Mix DJ: prima si rinuncia al brano mixabile', () => {
    const prev = makeTrack({ dj: dj({ energy: 3 }) })
    const mixabileForte = makeTrack({ dj: dj({ energy: 9, bpm: 124 }) })
    const calmoLento = makeTrack({ dj: dj({ energy: 4, bpm: 90 }) })
    expect(preferFlow([mixabileForte, calmoLento], flow({ prev, djMix: true }))).toEqual([calmoLento])
  })

  it('cambio di tempo: brani con BPM fuori dal limite, sempre dentro la fascia di energia', () => {
    const prev = makeTrack({ dj: dj({}) })
    const stesso = makeTrack({ dj: dj({ bpm: 125 }) })
    const lento = makeTrack({ dj: dj({ bpm: 98 }) })
    const lentoForte = makeTrack({ dj: dj({ bpm: 98, energy: 9 }) })
    const ignoto = makeTrack()
    const f = flow({ prev, djMix: true, tempoChange: true, energyRange: { min: 4, max: 7 } })
    expect(preferFlow([stesso, lento, lentoForte, ignoto], f)).toEqual([lento])
    // nessun tempo diverso: resta sullo stesso
    expect(preferFlow([stesso], f)).toEqual([stesso])
  })

  it('fascia di energia', () => {
    const t = [2, 4, 6, 8].map((e) => makeTrack({ dj: dj({ energy: e }) }))
    expect(preferFlow(t, flow({ energyRange: { min: 3, max: 6 } })).map((x) => x.dj!.energy)).toEqual([4, 6])
  })
})

describe('energia nei profili di rotazione', () => {
  it('legge la fascia del profilo, anche a metà o al contrario', async () => {
    const { profileEnergy } = await import('../src/core/rotationService')
    const base = { name: '', genres: [], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null }
    expect(profileEnergy(null)).toBeNull()
    expect(profileEnergy(base)).toBeNull()
    expect(profileEnergy({ ...base, energyMin: 3, energyMax: 6 })).toEqual({ min: 3, max: 6 })
    expect(profileEnergy({ ...base, energyMin: 7 })).toEqual({ min: 7, max: 10 })
    expect(profileEnergy({ ...base, energyMin: 8, energyMax: 2 })).toEqual({ min: 2, max: 8 })
  })

  it('l\'AI legge l\'energia della fascia e la mette nel profilo', async () => {
    const { cleanPlan, slotProfile } = await import('../src/core/aiRotation')
    const { plan } = cleanPlan(
      { slots: [{ name: 'Sera', days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '02:00', genres: [], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null, energyMin: 1, energyMax: 14 }] },
      { genres: [], yearMin: null, yearMax: null, music: 100 }
    )
    expect(slotProfile(plan.slots[0])).toMatchObject({ energyMin: 1, energyMax: 10 })
  })
})
