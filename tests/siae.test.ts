import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import type { ServerPlay } from '../src/core/ponteClient'
import { importPlays, serverIndex, syncServerPlays } from '../src/core/serverPlays'
import { missingFields, normalizeAuthors, quarterOf, quarterRange, siaeCsv, siaeRows } from '../src/core/siae'
import type { LogEntry } from '../src/core/types'
import { makeTrack } from './helpers'

const dir = mkdtempSync(join(tmpdir(), 'radio-siae-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
function entry(p: Partial<LogEntry>): LogEntry {
  return {
    id: ++n,
    trackId: null,
    startedAt: '2026-02-01T10:00:00.000Z',
    endedAt: '2026-02-01T10:03:00.000Z',
    playedSeconds: 180,
    source: 'regia',
    title: 'Albachiara',
    artist: 'Vasco Rossi',
    composer: 'Vasco Rossi / Alberto Rossi',
    publisher: '',
    isrc: '',
    iswc: '',
    siaeCode: '',
    kind: 'music',
    ...p
  }
}

describe('report SIAE', () => {
  it('trimestri in ora locale', () => {
    const [a, b] = quarterRange(2026, 4)
    expect(a).toEqual(new Date(2026, 9, 1))
    expect(b).toEqual(new Date(2027, 0, 1))
    expect(quarterOf(new Date(2026, 10, 15))).toEqual({ year: 2026, q: 4 })
    expect(() => quarterRange(2026, 5)).toThrow()
  })

  it('autori separati da virgola, senza doppioni', () => {
    expect(normalizeAuthors('Vasco Rossi / Tullio Ferro;  vasco rossi')).toBe('Vasco Rossi, Tullio Ferro')
    expect(normalizeAuthors('')).toBe('')
  })

  it('una riga per opera e interprete, solo musica, da tutte le fonti', () => {
    const t = makeTrack({ id: 900, title: 'Albachiara', artist: 'Vasco Rossi', composer: 'Vasco Rossi, Alberto Rossi', publisher: 'EMI', iswc: 'T-000.000.001-0' })
    const rows = siaeRows(
      [
        entry({ trackId: 900 }),
        entry({ trackId: 900, source: 'riserva', endedAt: null }),
        entry({ source: 'autonoma', title: 'ALBACHIARA', artist: 'vasco rossi' }),
        entry({ trackId: 900, playedSeconds: 12 }), // saltato subito: non conta
        entry({ kind: 'jingle', title: 'Sigla' }),
        entry({ source: 'flusso esterno', title: 'Radio amica' }),
        entry({ title: 'Sally', composer: '', isrc: 'itabc0000001' })
      ],
      new Map([[900, t]])
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ title: 'Albachiara', uses: 3, authors: 'Vasco Rossi, Alberto Rossi', publisher: 'EMI', iswc: 'T-000.000.001-0', trackId: 900 })
    expect(rows[1]).toMatchObject({ title: 'Sally', uses: 1, isrc: 'ITABC0000001', trackId: null })
    expect(missingFields(rows[0])).toEqual([])
    expect(missingFields(rows[1])).toEqual(['autori', 'editore'])
  })

  it('CSV nel tracciato del fac simile senza il prezzo', () => {
    const csv = siaeCsv([
      { title: 'A; b', authors: 'X, Y', publisher: 'E', performer: 'P', uses: 4, siaeCode: '012345', iswc: '', isrc: '', trackId: 1 }
    ])
    const [head, row] = csv.split('\n')
    expect(head).toBe('TITOLO OPERA;AUTORE;EDITORE;INTERPRETE;UTILIZZAZIONI;CODICE OPERA;CODICE ISWC;CODICE ISRC')
    expect(row).toBe('"A; b";X, Y;E;P;4;012345;;')
  })
})

describe('brani suonati dal server', () => {
  it('importati una volta sola e collegati ai brani della libreria', async () => {
    const db = new RadioDb(join(dir, 'a.db'))
    db.addFolder('/home/r/Musica', 'music')
    const id = db.upsertScanned({
      path: '/home/r/Musica/Vasco/Albachiara.mp3', kind: 'music', size: 1, mtime: 1, title: 'Albachiara', artist: 'Vasco Rossi',
      album: '', year: null, genre: '', composer: 'Vasco Rossi', publisher: '', isrc: '', duration: 260, bitrate: 320, sampleRate: 44100
    })
    const plays: ServerPlay[] = [
      { at: '2026-11-15T02:00:00.000Z', source: 'riserva', id: 'regia/Musica/Vasco/Albachiara.mp3', title: 'x', artist: 'y', duration: 260 },
      { at: '2026-11-15T02:05:00.000Z', source: 'autonoma', id: 'caricati/nuovo.mp3', title: 'Nuovo', artist: 'Ospite', duration: 200 }
    ]
    expect(importPlays(db, plays, serverIndex(db))).toBe(2)
    expect(importPlays(db, plays, serverIndex(db))).toBe(0)
    const log = db.listLog(new Date('2026-11-15T00:00:00Z'), new Date('2026-11-16T00:00:00Z'))
    expect(log.map((e) => [e.source, e.trackId, e.title, e.composer, e.playedSeconds])).toEqual([
      ['riserva', id, 'Albachiara', 'Vasco Rossi', 260],
      ['autonoma', null, 'Nuovo', '', 200]
    ])
    expect(db.lastServerPlay()).toBe('2026-11-15T02:05:00.000Z')

    // il download successivo riparte da poco prima dell'ultimo passaggio
    let asked: [Date, Date] | null = null
    const client = { listPlays: async (a: Date, b: Date) => ((asked = [a, b]), plays) }
    expect(await syncServerPlays(db, client as never, new Date('2026-11-15T10:00:00Z'))).toBe(0)
    expect(asked![0].toISOString()).toBe('2026-11-14T02:05:00.000Z')
    db.close()
  })
})

describe('brani suonati dal server: dati non validi', () => {
  it('una data illeggibile non blocca le importazioni successive', () => {
    const db = new RadioDb(join(dir, 'c.db'))
    const plays = [
      { at: 'non una data', source: 'riserva', id: '', title: 'Rotto', artist: 'X', duration: 100 },
      null,
      { at: '2026-11-15T03:00:00Z', source: 'esterna', id: 'sconosciuto/1', title: 'Buono', artist: 'Y', duration: 180, composer: 'Z' }
    ] as unknown as ServerPlay[]
    expect(importPlays(db, plays, new Map())).toBe(1)
    const log = db.listLog(new Date('2026-11-15T00:00:00Z'), new Date('2026-11-16T00:00:00Z'))
    expect(log.map((e) => [e.title, e.startedAt])).toEqual([['Buono', '2026-11-15T03:00:00.000Z']])
    db.close()
  })
})

describe('MusicBrainz nel database', () => {
  it('riempie solo i campi vuoti e tiene conto dei brani cercati', () => {
    const db = new RadioDb(join(dir, 'b.db'))
    const base = { kind: 'music' as const, size: 1, mtime: 1, album: '', year: null, genre: '', publisher: '', isrc: '', duration: 200, bitrate: 320, sampleRate: 44100 }
    const a = db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'A', artist: 'X', composer: 'Scritto a mano' })
    db.upsertScanned({ ...base, path: '/m/b.mp3', title: 'B', artist: 'Y', composer: '' })
    db.upsertScanned({ ...base, path: '/m/j.mp3', kind: 'jingle', title: 'J', artist: '', composer: '' })
    expect(db.mbStats()).toEqual({ todo: 2, checked: 0, found: 0 })
    db.saveMb(a, 'rec-1', { composer: 'Da MusicBrainz', isrc: 'IT0001', iswc: 'T-1', publisher: 'Ed' })
    const t = db.getTrack(a)!
    expect([t.composer, t.isrc, t.iswc, t.publisher]).toEqual(['Scritto a mano', 'IT0001', 'T-1', 'Ed'])
    expect(db.mbStats()).toEqual({ todo: 1, checked: 1, found: 1 })
    expect(db.mbPending().map((x) => x.title)).toEqual(['B'])
    expect(db.incompleteMusic().total).toBe(1)
    db.close()
  })
})
