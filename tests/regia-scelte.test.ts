import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { RadioDb, type ScannedFile } from '../src/core/db'
import { PlayoutEngine, restoreAndPersistMode, type PlayoutHost, type PlayoutMode } from '../src/core/playout'
import type { Track } from '../src/core/types'
import { FakeBackend, FakeClock, makeTrack } from './helpers'

function setup(pool: Track[]) {
  const clock = new FakeClock()
  const backend = new FakeBackend(clock)
  let i = 0
  const host: PlayoutHost = {
    fillQueue: async (_up, count) => Array.from({ length: count }, () => pool[i++ % pool.length]),
    logStart: async () => 1,
    logEnd: async () => {},
    expandEvent: async () => []
  }
  const engine = new PlayoutEngine(backend, host, { crossfadeSeconds: 3, targetLoudness: -16, autoQueueLength: 3 }, clock.now)
  const run = async (seconds: number, step = 0.25) => {
    for (let t = 0; t < seconds; t += step) {
      clock.advance(step)
      backend.settle()
      await engine.tick()
    }
  }
  return { clock, backend, engine, run }
}

const mk = (p: Partial<Track> = {}) => makeTrack({ cueIn: 0, mixPoint: 20, cueOut: 24, duration: 25, ...p })

function scanned(p: Partial<ScannedFile> = {}): ScannedFile {
  return {
    path: '/m/a.mp3', kind: 'music', size: 1, mtime: 1, title: 'Titolo file', artist: 'Artista file', album: 'Album file',
    year: 1999, genre: 'Pop', composer: '', publisher: '', isrc: '', duration: 200, bitrate: 320, sampleRate: 44100, ...p
  }
}

describe('modalità dopo un riavvio o un blackout', () => {
  it('se era in AUTOMATICO riparte in automatico e suona da sola', async () => {
    const { engine, backend, run } = setup([mk(), mk(), mk()])
    const saved: PlayoutMode[] = []
    restoreAndPersistMode(engine, 'auto', (m) => saved.push(m))
    expect(engine.getMode()).toBe('auto')
    await run(1)
    expect(engine.snapshot().onAir).toHaveLength(1)
    expect(backend.players.length).toBeGreaterThan(0)
    expect(saved).toEqual([])
  })

  it('se era in MANUALE resta ferma in manuale', async () => {
    const { engine, run } = setup([mk(), mk()])
    restoreAndPersistMode(engine, 'manual', () => {})
    await run(1)
    expect(engine.getMode()).toBe('manual')
    expect(engine.snapshot().onAir).toHaveLength(0)
  })

  it('salva la modalità a ogni cambio (tasto, STOP), una volta sola per cambio', async () => {
    const { engine, run } = setup([mk(), mk(), mk()])
    const saved: PlayoutMode[] = []
    restoreAndPersistMode(engine, 'manual', (m) => saved.push(m))
    engine.setMode('auto')
    await run(1)
    engine.stop()
    await run(1)
    expect(saved).toEqual(['auto', 'manual'])
  })

  it('la modalità si salva nelle impostazioni; un valore rovinato vale MANUALE', () => {
    const db = new RadioDb(':memory:')
    expect(db.getSettings().playoutMode).toBe('manual')
    db.saveSettings({ playoutMode: 'auto' })
    expect(db.getSettings().playoutMode).toBe('auto')
    db.db.prepare("UPDATE settings SET value = '\"boh\"' WHERE key = 'playoutMode'").run()
    expect(db.getSettings().playoutMode).toBe('manual')
    db.close()
  })
})

describe('jingle della cartwall', () => {
  it('un clic su un jingle che sta già suonando non ne fa partire una seconda copia', async () => {
    const { engine, backend } = setup([mk()])
    const j = mk({ kind: 'jingle' })
    await engine.playCart(j)
    await engine.playCart(j)
    expect(engine.snapshot().carts).toHaveLength(1)
    expect(backend.players).toHaveLength(1)
    // un altro jingle invece parte
    await engine.playCart(mk({ kind: 'jingle' }))
    expect(engine.snapshot().carts).toHaveLength(2)
  })

  it('due clic ravvicinati mentre il jingle carica ne fanno partire uno solo', async () => {
    const { engine, backend } = setup([mk()])
    const j = mk({ kind: 'jingle' })
    await Promise.all([engine.playCart(j), engine.playCart(j)])
    expect(backend.players).toHaveLength(1)
  })

  it('"Ferma jingle" funziona e dopo il jingle si può risuonare', async () => {
    const { engine, backend } = setup([mk()])
    const j = mk({ kind: 'jingle' })
    await engine.playCart(j)
    engine.stopCarts()
    expect(backend.players[0].fadingFor).toBe(0.5)
    backend.settle()
    await engine.playCart(j)
    expect(backend.players).toHaveLength(2)
    expect(engine.snapshot().carts).toHaveLength(1)
  })
})

describe('ricerca senza accenti', () => {
  it('"citta" trova "città" e "CITTÀ", "perche" trova "perché", e viceversa', () => {
    const db = new RadioDb(':memory:')
    db.upsertScanned(scanned({ path: '/1.mp3', title: 'CITTÀ VUOTA', artist: 'Mina' }))
    db.upsertScanned(scanned({ path: '/2.mp3', title: 'La città', artist: 'X' }))
    db.upsertScanned(scanned({ path: '/3.mp3', title: 'Perché no', artist: 'Lucio Battisti' }))
    db.upsertScanned(scanned({ path: '/4.mp3', title: '100% amore_mio', artist: 'Y' }))
    expect(db.searchTracks({ text: 'citta' }).total).toBe(2)
    expect(db.searchTracks({ text: 'CITTA' }).total).toBe(2)
    expect(db.searchTracks({ text: 'città' }).total).toBe(2)
    expect(db.searchTracks({ text: 'perche' }).total).toBe(1)
    expect(db.searchTracks({ text: 'PERCHÉ battisti' }).total).toBe(1)
    // % e _ restano lettere normali
    expect(db.searchTracks({ text: '100%' }).total).toBe(1)
    expect(db.searchTracks({ text: 'amore_' }).total).toBe(1)
    expect(db.searchTracks({ text: 'a_ore' }).total).toBe(0)
    db.close()
  })

  it('resta veloce con 20.000 brani', () => {
    const db = new RadioDb(':memory:')
    db.db.exec('BEGIN')
    for (let i = 0; i < 20000; i++)
      db.upsertScanned(scanned({ path: `/m/${i}.mp3`, title: i % 2 ? `Brano città ${i}` : `Canzone ${i}`, artist: `Artista ${i % 500}` }))
    db.db.exec('COMMIT')
    const t0 = performance.now()
    const r = db.searchTracks({ text: 'citta artista', limit: 200 })
    const ms = performance.now() - t0
    expect(r.total).toBe(10000)
    expect(ms).toBeLessThan(2000)
    db.close()
  })
})

describe('correzioni a mano nella scheda brano', () => {
  it('quando il file cambia, titolo/artista/album/anno/genere corretti a mano restano', () => {
    const db = new RadioDb(':memory:')
    const id = db.upsertScanned(scanned())
    db.updateTrack(id, { title: 'Titolo giusto', year: 2001 })
    db.upsertScanned(scanned({ mtime: 2, title: 'Nuovo titolo file', artist: 'Nuovo artista', album: 'Nuovo album', year: 2020, genre: 'Rock' }))
    const t = db.getTrack(id)!
    expect(t.title).toBe('Titolo giusto')
    expect(t.year).toBe(2001)
    // i campi non toccati a mano seguono il file
    expect(t.artist).toBe('Nuovo artista')
    expect(t.album).toBe('Nuovo album')
    expect(t.genre).toBe('Rock')
    db.close()
  })

  it('un campo rimandato uguale non conta come correzione', () => {
    const db = new RadioDb(':memory:')
    const id = db.upsertScanned(scanned())
    db.updateTrack(id, { title: 'Titolo file', artist: 'Artista giusto' })
    db.upsertScanned(scanned({ mtime: 2, title: 'Titolo cambiato', artist: 'Altro' }))
    expect(db.getTrack(id)!).toMatchObject({ title: 'Titolo cambiato', artist: 'Artista giusto' })
    db.close()
  })

  it('i punti di mix corretti a mano restano dopo la nuova analisi, gli altri si ricalcolano', () => {
    const db = new RadioDb(':memory:')
    const id = db.upsertScanned(scanned())
    db.saveAnalysis(id, { duration: 200, loudness: -14, cueIn: 0.5, cueOut: 199, mixPoint: 195 })
    db.updateTrack(id, { mixPoint: 190 })
    db.upsertScanned(scanned({ mtime: 2, duration: 210 }))
    db.saveAnalysis(id, { duration: 210, loudness: -12, cueIn: 1, cueOut: 209, mixPoint: 205 })
    expect(db.getTrack(id)!).toMatchObject({ duration: 210, loudness: -12, cueIn: 1, cueOut: 209, mixPoint: 190 })
    db.close()
  })

  it('autori, editore e ISRC restano protetti come prima', () => {
    const db = new RadioDb(':memory:')
    const id = db.upsertScanned(scanned())
    db.updateTrack(id, { composer: 'Mogol', publisher: 'Ed', isrc: 'IT0001' })
    db.upsertScanned(scanned({ mtime: 2, composer: 'Altro', publisher: 'Altra', isrc: 'XX' }))
    expect(db.getTrack(id)!).toMatchObject({ composer: 'Mogol', publisher: 'Ed', isrc: 'IT0001' })
    db.close()
  })

  it('database di una versione precedente: si aggiorna e nessun brano risulta corretto a mano', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radio-manual-'))
    try {
      const file = join(dir, 'radio.db')
      let db = new RadioDb(file)
      const id = db.upsertScanned(scanned())
      db.close()
      const raw = new DatabaseSync(file)
      raw.exec('ALTER TABLE tracks DROP COLUMN manual_fields')
      raw.close()
      db = new RadioDb(file)
      db.upsertScanned(scanned({ mtime: 2, title: 'Dal file' }))
      expect(db.getTrack(id)!.title).toBe('Dal file')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
