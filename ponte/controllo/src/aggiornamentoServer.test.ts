import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AggiornamentoServer, confrontaVersioni, ultimaVersione } from './aggiornamentoServer.ts'

const rel = (v: string, zip = true, draft = false) => ({ tag_name: `v${v}`, draft, assets: zip ? [{ name: `RadioPonte-server-${v}.zip` }] : [] })

describe('aggiornamento del server', () => {
  it('confronta le versioni numero per numero', () => {
    expect(confrontaVersioni('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(confrontaVersioni('0.2.0', '0.10.0')).toBeLessThan(0)
    expect(confrontaVersioni('1.0.0', '1.0.0')).toBe(0)
  })
  it("sceglie l'ultima release con lo ZIP del server, saltando bozze e tag strani", () => {
    expect(ultimaVersione([rel('0.1.2'), rel('0.1.10'), rel('0.1.11', false), rel('0.2.0', true, true), { tag_name: 'prova' }])).toBe('0.1.10')
    expect(ultimaVersione({ message: 'Not Found' })).toBeNull()
  })
  it('dice se c’è una versione nuova e lascia la richiesta solo per quella', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agg-'))
    const a = new AggiornamentoServer({ attuale: '0.1.1', cartellaRichieste: dir, scarica: async () => [rel('0.1.1'), rel('0.1.3')] })
    expect(a.stato().disponibile).toBe(false)
    await a.controlla()
    expect(a.stato()).toMatchObject({ attuale: '0.1.1', ultima: '0.1.3', disponibile: true, inCorso: false })
    expect(() => a.chiedi('0.1.2')).toThrow(/non è l'ultima/)
    expect(() => a.chiedi('0.1.3; rm -rf /')).toThrow(/non valida/)
    a.chiedi('0.1.3')
    expect(readFileSync(join(dir, 'aggiorna'), 'utf8').trim()).toBe('0.1.3')
    expect(a.stato().inCorso).toBe(true)
    expect(a.stato().servizioAssente).toBe(false)
    utimesSync(join(dir, 'aggiorna'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    expect(a.stato().servizioAssente).toBe(true)
    a.annulla()
    expect(existsSync(join(dir, 'aggiorna'))).toBe(false)
    writeFileSync(join(dir, 'esito-aggiornamento.json'), JSON.stringify({ quando: '2026-11-17T10:00:00Z', ok: true, messaggio: 'Aggiornato alla 0.1.3' }))
    expect(a.stato().esito?.ok).toBe(true)
  })
  it('senza rete tiene il valore di prima; versione installata sconosciuta = aggiornabile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agg-'))
    let rete = true
    const a = new AggiornamentoServer({ attuale: '', cartellaRichieste: dir, scarica: async () => { if (!rete) throw new Error('giù'); return [rel('0.1.3')] } })
    await a.controlla()
    rete = false
    await a.controlla()
    expect(a.stato()).toMatchObject({ ultima: '0.1.3', disponibile: true })
  })
})
