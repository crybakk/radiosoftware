import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { leggiTitoli, promptTitoli } from '../src/core/aiTitoli'
import { RadioDb } from '../src/core/db'
import { AiTitoliService } from '../src/main/aiTitoli'
import type { LlmEngine } from '../src/main/ai'

const base = { kind: 'music' as const, size: 1, mtime: 1, album: '', year: null, bitrate: 320, sampleRate: 44100, composer: '', publisher: '', isrc: '', genre: '', duration: 200 }

describe('titoli giudicati dall\'AI', () => {
  it('prompt numerato e risposta letta solo con numeri e motivi validi', () => {
    const p = promptTitoli([{ artist: 'DJ X', title: 'Summer Mix 2019', path: 'C:\\Musica\\Mix\\a.mp3' }, { artist: '', title: '', path: '/m/b.mp3' }])
    expect(p).toBe('1. DJ X — Summer Mix 2019 [Musica/Mix]\n2. (artista sconosciuto) — (senza titolo) [m]')
    const r = leggiTitoli('{"segnalati":[{"n":1,"motivo":"mix o DJ set"},{"n":9,"motivo":"mix o DJ set"},{"n":2,"motivo":"inventato"}]}', [{ id: 10 }, { id: 11 }])
    expect(r).toEqual([
      { id: 10, motivo: 'mix o DJ set' },
      { id: 11, motivo: '' }
    ])
    expect(() => leggiTitoli('{}', [{ id: 1 }])).toThrow()
  })

  it('analizza a gruppi col modello aperto una volta, i segnalati vanno nella lista da controllare', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitit-'))
    const db = new RadioDb(join(dir, 'r.db'))
    const mix = db.upsertScanned({ ...base, path: '/m/mix.mp3', title: 'Summer Mix 2019', artist: 'DJ X' })
    db.upsertScanned({ ...base, path: '/m/ok.mp3', title: 'Canzone', artist: 'Y' })
    // già segnalato dalle regole: non va all'AI
    db.upsertScanned({ ...base, path: '/m/t.mp3', title: 'Track 01', artist: 'Z' })
    const model = join(dir, 'm.gguf')
    writeFileSync(model, 'GGUF')
    const asked: string[] = []
    let opened = 0
    let closed = 0
    const engine: LlmEngine = {
      complete: async () => {
        throw new Error('non deve usare complete')
      },
      open: async () => {
        opened++
        return {
          ask: async (user) => {
            asked.push(user)
            const n = user.split('\n').findIndex((l) => l.includes('Mix')) + 1
            return JSON.stringify({ segnalati: n ? [{ n, motivo: 'mix o DJ set' }] : [] })
          },
          close: async () => void closed++
        }
      }
    }
    const statuses: boolean[] = []
    const svc = new AiTitoliService({ db, engine, modelPath: () => model, busy: () => false, onStatus: (s) => statuses.push(s.running) })
    svc.start()
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (!svc.status().running) {
          clearInterval(t)
          r()
        }
      }, 5)
    })
    expect(opened).toBe(1)
    expect(closed).toBe(1)
    expect(asked.join('\n')).not.toContain('Track 01')
    expect(svc.status()).toMatchObject({ done: 3, total: 3, flagged: 1, error: null })
    const lista = db.daControllare().tracks.map((t) => [t.id, t.motivo])
    expect(lista).toContainEqual([mix, "secondo l'AI: mix o DJ set"])
    // già giudicati: una nuova analisi non chiede niente
    asked.length = 0
    expect(db.pendingAiTitoli()).toEqual([])
  })

  it('senza modello o con l\'AI occupata non parte', () => {
    const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'aitit-')), 'r.db'))
    const engine: LlmEngine = { complete: async () => '{}' }
    expect(() => new AiTitoliService({ db, engine, modelPath: () => '/non/esiste', busy: () => false }).start()).toThrow(/scarica/)
    const dir = mkdtempSync(join(tmpdir(), 'aitit-'))
    writeFileSync(join(dir, 'm'), 'x')
    expect(() => new AiTitoliService({ db, engine, modelPath: () => join(dir, 'm'), busy: () => true }).start()).toThrow(/rotazioni/)
  })

  it('live dal suono: oltre i secondi di applausi il brano va da controllare', () => {
    const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'lives-')), 'r.db'))
    const a = db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'Canzone', artist: 'X' })
    const b = db.upsertScanned({ ...base, path: '/m/b.mp3', title: 'Altra', artist: 'Y' })
    expect(db.pendingLive().map((t) => t.id)).toEqual([a, b])
    db.saveLive(a, 6.5)
    db.saveLive(b, 0.5)
    expect(db.pendingLive()).toEqual([])
    expect(db.liveStats()).toEqual({ done: 2, total: 2 })
    expect(db.daControllare().tracks.map((t) => [t.id, t.motivo])).toEqual([[a, 'live (dal suono: 6.5 s di applausi)']])
    // file cambiato: si riascolta
    db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'Canzone', artist: 'X', mtime: 5 })
    expect(db.pendingLive().map((t) => t.id)).toEqual([a])
  })
})
