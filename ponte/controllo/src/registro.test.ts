import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PlayLog } from './registro.ts'

describe('registro dei brani suonati dal server', () => {
  it('aggiunge, filtra per date e toglie le voci troppo vecchie', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'reg-')), 'r.jsonl')
    const old = new Date('2025-01-01T10:00:00Z').toISOString()
    writeFileSync(file, `${JSON.stringify({ at: old, source: 'riserva', id: 'x', title: 'Vecchio', artist: 'A', duration: 200 })}\nriga rovinata\n`)
    const now = Date.parse('2026-11-15T12:00:00Z')
    const log = new PlayLog(file, () => now)
    expect(readFileSync(file, 'utf8')).not.toContain('Vecchio')
    log.add({ source: 'riserva', id: 'regia/Rock/a.mp3', title: 'Albachiara', artist: 'Vasco', duration: 250.123 })
    log.add({ at: '2026-11-15T13:00:00.000Z', source: 'autonoma', id: 'caricati/b.mp3', title: 'B', artist: 'C', duration: 100 })
    const all = log.list(new Date('2026-11-01'), new Date('2026-12-01'))
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({ source: 'riserva', at: '2026-11-15T12:00:00.000Z', duration: 250.1 })
    expect(log.list(new Date('2026-11-15T12:30:00Z'), new Date('2026-12-01'))).toHaveLength(1)
  })

  it('i passaggi vecchi aggiunti adesso (sconosciuto etichettato dopo giorni) arrivano anche a chi chiede le voci recenti', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'reg-')), 'r.jsonl')
    const now = Date.parse('2026-11-15T12:00:00Z')
    const log = new PlayLog(file, () => now)
    log.add({ at: '2026-11-01T21:00:00.000Z', source: 'esterna', id: 'sconosciuto/1', title: 'T', artist: 'A', duration: 200 })
    // la regia scarica dall'ultimo passaggio importato meno un giorno
    expect(log.list(new Date('2026-11-14T12:00:00Z'), new Date('2026-11-15T12:01:00Z')).map((p) => p.at)).toEqual(['2026-11-01T21:00:00.000Z'])
    expect(log.list(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-02T00:00:00Z'))).toHaveLength(1)
  })

  it('righe valide in JSON ma senza data non bloccano il registro', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'reg-')), 'r.jsonl')
    writeFileSync(file, 'null\n{}\n5\n')
    const log = new PlayLog(file, () => Date.parse('2026-11-15T12:00:00Z'))
    expect(log.list(new Date('2026-01-01'), new Date('2027-01-01'))).toEqual([])
  })
})
