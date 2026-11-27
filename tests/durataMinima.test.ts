import { describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import { CUE_ANALYSIS_VERSION } from '../src/core/musicBounds'

const base = { kind: 'music' as const, size: 1, mtime: 1, album: '', year: null, bitrate: 320, sampleRate: 44100, composer: '', publisher: '', isrc: '', genre: 'Pop' }

describe('durata minima netta dei brani', () => {
  it('la regia non sceglie da sola i brani con poca musica, ma restano in libreria', () => {
    const db = new RadioDb(':memory:')
    db.upsertScanned({ ...base, path: '/m/canzone.mp3', title: 'Canzone', artist: 'X', duration: 240 })
    // 2:30 di file, ma 40 s di parlato prima e 20 s di applausi dopo: 1:30 di musica
    db.upsertScanned({ ...base, path: '/m/live.mp3', title: 'Dal vivo', artist: 'Y', duration: 150 })
    db.upsertScanned({ ...base, path: '/m/intro.mp3', title: 'Intro', artist: 'Z', duration: 50 })
    db.upsertScanned({ ...base, path: '/j/sigla.mp3', title: 'Sigla', artist: '', duration: 10, kind: 'jingle' })
    const id = (p: string): number => db.findByPath(p)!.id
    db.saveAnalysis(id('/m/canzone.mp3'), { duration: 240, loudness: -10, cueIn: 0.5, cueOut: 238, mixPoint: 232 })
    db.saveAnalysis(id('/m/live.mp3'), { duration: 150, loudness: -10, cueIn: 40, cueOut: 130, mixPoint: 125 })

    // predefinito: 2 minuti (scelta di cristian del 27/11/2026)
    expect(db.getSettings().minTrackSeconds).toBe(120)
    expect(db.rotationCandidates('music').map((t) => t.title)).toEqual(['Canzone'])
    expect(db.rotationCandidates('jingle').map((t) => t.title)).toEqual(['Sigla'])
    for (let i = 0; i < 20; i++) expect(db.randomTrack({ kind: 'music' })?.title).toBe('Canzone')
    // in libreria ci sono tutti: si possono mettere a mano
    expect(db.searchTracks({ text: '' }).tracks.map((t) => t.title).sort()).toEqual(['Canzone', 'Dal vivo', 'Intro', 'Sigla'])
    expect(db.libraryStats()).toMatchObject({ hiddenShort: 2, minTrackSeconds: 120 })

    db.saveSettings({ minTrackSeconds: 60 })
    expect(db.rotationCandidates('music').map((t) => t.title).sort()).toEqual(['Canzone', 'Dal vivo'])
    db.saveSettings({ minTrackSeconds: 0 })
    expect(db.rotationCandidates('music')).toHaveLength(3)
    expect(db.libraryStats().hiddenShort).toBe(0)
  })

  it('la musica analizzata con il calcolo vecchio si rianalizza, e se inizio o fine cambiano si rifà l\'analisi DJ', () => {
    const db = new RadioDb(':memory:')
    db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'A', artist: 'X', duration: 240 })
    db.upsertScanned({ ...base, path: '/j/s.mp3', title: 'S', artist: '', duration: 10, kind: 'jingle' })
    const a = db.findByPath('/m/a.mp3')!.id
    const s = db.findByPath('/j/s.mp3')!.id
    db.saveAnalysis(a, { duration: 240, loudness: -10, cueIn: 0.5, cueOut: 238, mixPoint: 232 })
    db.saveAnalysis(s, { duration: 10, loudness: -10, cueIn: 0, cueOut: 10, mixPoint: 10 })
    expect(db.pendingAnalysis()).toEqual([])
    // database di prima: analisi fatte con la versione 1 (solo silenzio)
    db.db.exec('UPDATE tracks SET cue_ver = 1')
    expect(db.pendingAnalysis().map((t) => t.title)).toEqual(['A'])
    expect(db.countPendingAnalysis()).toBe(1)
    db.saveDj(a, { bpm: 120, firstDownbeat: 0.5, gridConfidence: 0.9, key: '8A', energy: 6, introEnd: 16.5, outroStart: 222 })
    expect(db.pendingDj()).toEqual([])
    // stessa analisi: l'analisi DJ resta
    db.saveAnalysis(a, { duration: 240, loudness: -10, cueIn: 0.5, cueOut: 238, mixPoint: 232 })
    expect(db.pendingDj()).toEqual([])
    expect(db.pendingAnalysis()).toEqual([])
    expect((db.db.prepare('SELECT cue_ver FROM tracks WHERE id = ?').get(a) as { cue_ver: number }).cue_ver).toBe(CUE_ANALYSIS_VERSION)
    // tolti 12 s di parlato all'inizio: battiti e intro si ricalcolano
    db.saveAnalysis(a, { duration: 240, loudness: -10, cueIn: 12.5, cueOut: 238, mixPoint: 232 })
    expect(db.pendingDj().map((t) => t.title)).toEqual(['A'])
  })
})
