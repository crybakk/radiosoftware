import { describe, expect, it } from 'vitest'
import { AI_LABEL, buildPrompt, cleanPlan, daysLabel, matchCount, planEvents, planSchema, summarize, trackGenres } from '../src/core/aiRotation'
import { makeTrack } from './helpers'

const tracks = [
  makeTrack({ genre: 'Pop', mbGenres: 'pop rock, italian pop', year: 1985 }),
  makeTrack({ genre: 'Jazz', year: 1960 }),
  makeTrack({ genre: 'pop', mbGenres: '', year: 2010 }),
  makeTrack({ genre: '', mbGenres: 'ambient', year: null })
]
const lib = summarize(tracks)

const slot = (o: Record<string, unknown>) => ({ name: 'F', days: [1, 2, 3, 4, 5], start: '07:00', end: '10:00', genres: [], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null, ...o })

describe('rotazioni generate dall\'AI', () => {
  it('riassume generi e anni della libreria', () => {
    expect(trackGenres(tracks[0])).toEqual(['pop', 'pop rock', 'italian pop'])
    expect(lib.genres[0]).toEqual({ name: 'pop', count: 2 })
    expect([lib.yearMin, lib.yearMax, lib.music]).toEqual([1960, 2010, 4])
    const p = buildPrompt('  dalle 7 alle 10 pop  ', lib)
    expect(p.system).toContain('pop (2)')
    expect(p.system).toContain('dal 1960 al 2010')
    expect(p.user).toBe('Palinsesto:\ndalle 7 alle 10 pop')
    const schema = JSON.stringify(planSchema(['pop', 'jazz']))
    expect(schema).toContain('"enum":["pop","jazz"]')
  })

  it('ricontrolla il piano: generi della libreria, orari, giorni, sovrapposizioni', () => {
    const { plan, warnings } = cleanPlan(
      {
        slots: [
          slot({ name: 'Mattina', genres: ['Pop', 'reggaeton', 'pop'], yearFrom: 1999, yearTo: 1980 }),
          slot({ name: 'Rotta', start: '25:00' }),
          slot({ name: 'Senza giorni', days: [9] }),
          slot({ name: 'Notte', days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '06:00', genres: ['jazz', 'ambient'] }),
          slot({ name: 'Sopra', start: '09:00', end: '11:00' })
        ]
      },
      lib
    )
    expect(plan.slots.map((s) => s.name)).toEqual(['Mattina', 'Sopra', 'Notte'])
    const m = plan.slots[0]
    expect(m.genres).toEqual(['pop'])
    expect([m.yearFrom, m.yearTo]).toEqual([1980, 1999])
    expect(warnings).toEqual([
      '"Mattina": il genere "reggaeton" non è nella libreria, tolto',
      '"Rotta": orario non valido, tolta',
      '"Senza giorni": nessun giorno, tolta',
      '"Mattina" e "Sopra" si sovrappongono: vince quella che parte dopo'
    ])
    expect(cleanPlan({}, lib).warnings[0]).toMatch(/nessuna fascia/)
  })

  it('conta i brani di ogni fascia', () => {
    expect(matchCount(slot({ genres: ['pop'] }), tracks)).toBe(2)
    expect(matchCount(slot({ genres: ['pop'], yearFrom: 1980, yearTo: 1989 }), tracks)).toBe(1)
    expect(matchCount(slot({}), tracks)).toBe(4)
  })

  it('trasforma il piano in eventi, tornando alle regole normali a fine fascia', () => {
    const { plan } = cleanPlan(
      {
        slots: [
          slot({ name: 'Mattina', genres: ['pop'], jingleEvery: 3 }),
          slot({ name: 'Tarda mattina', start: '10:00', end: '13:00' }),
          slot({ name: 'Notte', days: [5, 6], start: '23:00', end: '02:00', genres: ['jazz'] })
        ]
      },
      lib
    )
    const ev = planEvents(plan)
    expect(ev.map((e) => [e.label, e.time, e.days.join('')])).toEqual([
      [`${AI_LABEL}Mattina`, '07:00', '12345'],
      [`${AI_LABEL}Tarda mattina`, '10:00', '12345'],
      [`${AI_LABEL}fine Tarda mattina`, '13:00', '12345'],
      [`${AI_LABEL}Notte`, '23:00', '56'],
      [`${AI_LABEL}fine Notte`, '02:00', '06']
    ])
    expect(ev[0].actions).toEqual([
      { type: 'rotation', profile: { name: 'Mattina', genres: ['pop'], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: 3 } }
    ])
    expect(ev[2].actions).toEqual([{ type: 'rotation', profile: null }])
    expect(ev.every((e) => e.mode === 'soft' && e.enabled)).toBe(true)
  })

  it('scrive i giorni in parole', () => {
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6])).toBe('tutti i giorni')
    expect(daysLabel([5, 1, 2, 3, 4])).toBe('dal lunedì al venerdì')
    expect(daysLabel([0, 6])).toBe('sabato e domenica')
    expect(daysLabel([0, 3])).toBe('mercoledì, domenica')
  })
})
