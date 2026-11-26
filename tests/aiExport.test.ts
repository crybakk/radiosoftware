import { describe, expect, it } from 'vitest'
import { cleanPlan, exportForClaude, parseImportedPlan, type LibrarySummary } from '../src/core/aiRotation'

const lib: LibrarySummary = {
  genres: [
    { name: 'pop', count: 900 },
    { name: 'italian', count: 400 },
    { name: 'electronic', count: 200 }
  ],
  yearMin: 1960,
  yearMax: 2026,
  music: 1500
}

describe('rotazioni preparate da Claude', () => {
  it('il file contiene palinsesto, regole, formato e generi', () => {
    const md = exportForClaude('Venerdì 19-21 Party: dance ed elettronica', lib, new Date(2026, 10, 25))
    expect(md).toContain('Venerdì 19-21 Party')
    expect(md).toContain('- genres: SOLO generi')
    expect(md).toContain('"slots"')
    expect(md).toContain('- electronic (200)')
    expect(md).toContain('Brani di musica: 1500. Anni dei brani: dal 1960 al 2026.')
  })

  it('importa la risposta con il blocco json in mezzo al testo', () => {
    const risposta = `Ecco il piano:\n\n\`\`\`json\n{"slots":[{"name":"Party","days":[5],"start":"19:00","end":"21:00","genres":["electronic","dance"],"yearFrom":null,"yearTo":null,"artistSeparationMinutes":120,"jingleEvery":null,"energyMin":8,"energyMax":10}]}\n\`\`\`\n\nBuon ascolto!`
    const { plan, warnings } = cleanPlan(parseImportedPlan(risposta), lib)
    expect(plan.slots).toHaveLength(1)
    expect(plan.slots[0]).toMatchObject({ name: 'Party', days: [5], genres: ['electronic'], energyMin: 8 })
    expect(warnings.join()).toContain('"dance" non è nella libreria')
  })

  it('importa anche il JSON puro', () => {
    expect(parseImportedPlan('{"slots":[]}')).toEqual({ slots: [] })
  })

  it('senza piano un errore chiaro', () => {
    expect(() => parseImportedPlan('ciao, non so')).toThrow('non c\'è un piano valido')
  })
})

describe('annunci con la voce nel piano importato', () => {
  it('diventano eventi "voce" ripetuti, con i controlli', async () => {
    const { planEvents } = await import('../src/core/aiRotation')
    const { plan, warnings } = cleanPlan(
      {
        slots: [],
        announcements: [
          { name: 'Ora esatta', days: [1, 2, 3, 4, 5], start: '07:00', end: '19:00', everyMinutes: 60, text: 'Sono le {ora} su {radio}' },
          { name: 'Troppo spesso', days: [0], start: '10:00', end: '12:00', everyMinutes: 5, text: 'Ciao {nome}' },
          { name: 'Vuoto', days: [0], start: '10:00', end: null, everyMinutes: 0, text: '' }
        ]
      },
      lib
    )
    expect(plan.announcements).toHaveLength(2)
    expect(plan.announcements![1].everyMinutes).toBe(15)
    expect(warnings.join('\n')).toContain('{nome} non è un segnaposto')
    expect(warnings.join('\n')).toContain('"Vuoto": senza testo')
    const ev = planEvents(plan)
    expect(ev[0]).toMatchObject({ label: 'AI · annuncio Ora esatta', time: '07:00', repeatMinutes: 60, untilTime: '19:00', actions: [{ type: 'voice', text: 'Sono le {ora} su {radio}' }] })
  })

  it('il file per Claude spiega gli annunci', () => {
    expect(exportForClaude('x', lib)).toContain('"announcements"')
  })
})
