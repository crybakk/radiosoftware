import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CollegamentoStudio } from './collegamentoStudio.ts'

describe('registro dei collegamenti dello studio', () => {
  it('nessuna interruzione se la regia è rimasta collegata', () => {
    let t = 1000
    const c = new CollegamentoStudio(null, () => t)
    c.avvio()
    t = 2000
    c.collegata(true)
    t = 10_000
    expect(c.interruzioni(5000, 9000)).toEqual([])
  })

  it('trova le cadute dentro l\'intervallo, anche quella non ancora finita', () => {
    let t = 0
    const c = new CollegamentoStudio(null, () => t)
    c.collegata(true)
    t = 6000
    c.collegata(false)
    t = 7000
    c.collegata(true)
    t = 8500
    c.collegata(false)
    expect(c.interruzioni(5000, 9000)).toEqual([
      { from: 6000, to: 7000, kind: 'scollegata' },
      { from: 8500, to: 9000, kind: 'scollegata' }
    ])
  })

  it('regia già scollegata all\'inizio, e nessun dato = interruzione', () => {
    let t = 0
    const c = new CollegamentoStudio(null, () => t)
    expect(c.interruzioni(5000, 9000)).toEqual([{ from: 5000, to: 9000, kind: 'scollegata' }])
    c.collegata(false)
    t = 6000
    c.collegata(true)
    expect(c.interruzioni(5000, 9000)).toEqual([{ from: 5000, to: 6000, kind: 'scollegata' }])
  })

  it('un riavvio del server conta come interruzione fino al nuovo collegamento', () => {
    let t = 0
    const c = new CollegamentoStudio(null, () => t)
    c.collegata(true)
    t = 6000
    c.avvio()
    t = 6004
    c.collegata(true)
    expect(c.interruzioni(5000, 9000)).toEqual([{ from: 6000, to: 6004, kind: 'avvio' }])
  })

  it('stato ripetuto non aggiunge voci e il registro sopravvive al riavvio', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'coll-')), 'c.json')
    let t = 0
    const c = new CollegamentoStudio(f, () => t)
    c.collegata(true)
    t = 100
    c.collegata(true)
    t = 6000
    c.collegata(false)
    const d = new CollegamentoStudio(f, () => t)
    expect(d.interruzioni(5000, 9000)).toEqual([{ from: 6000, to: 9000, kind: 'scollegata' }])
  })
})
