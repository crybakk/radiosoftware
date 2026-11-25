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
