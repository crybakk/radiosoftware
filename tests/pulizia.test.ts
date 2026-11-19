import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import { CARTELLA_SCARTI, chiaveDoppione, copiaDaTenere, motivoNonRadiofonico, percorsoScarto } from '../src/core/pulizia'
import { rimettiInLibreria, spostaNegliScarti } from '../src/main/pulizia'
import { makeTrack } from './helpers'

const base = { kind: 'music' as const, size: 1, mtime: 1, album: '', year: null, bitrate: 320, sampleRate: 44100, composer: '', publisher: '', isrc: '', genre: '', duration: 200 }
const motivo = (title: string, artist = 'Artista', path = '/m/x.mp3'): string | null => motivoNonRadiofonico(makeTrack({ title, artist, path }))

describe('brani non radiofonici', () => {
  it('segnala titoli generici, live@, nomi di file e registrazioni', () => {
    expect(motivo('Track 01')).toMatch(/generico/)
    expect(motivo('Traccia 3')).toMatch(/generico/)
    expect(motivo('04 - Track 4')).toMatch(/generico/)
    expect(motivo('AudioTrack 05')).toMatch(/generico/)
    expect(motivo('Live@Rock in Rio')).toMatch(/live@/)
    expect(motivo('Canzone', 'DJ', '/m/DJ Live @ Ibiza 2019/01.mp3')).toMatch(/live@/)
    expect(motivo('Untitled')).toMatch(/vero titolo/)
    expect(motivo('Sconosciuto 2')).toMatch(/vero titolo/)
    expect(motivo('')).toMatch(/senza titolo/)
    expect(motivo('0012')).toMatch(/numeri/)
    expect(motivo('REC_0012')).toMatch(/registrazione/)
    expect(motivo('Nuova registrazione 5')).toMatch(/registrazione/)
    expect(motivo('canzone.mp3')).toMatch(/nome del file/)
    expect(motivo('AUD_20190504_1830', '')).toBeTruthy()
    expect(motivo('Bohemian Rhapsody (Live at Wembley)')).toMatch(/live/)
    expect(motivo('Intervista a Vasco')).toBe('intervista')
  })

  it('lascia stare i titoli veri, anche se somigliano', () => {
    for (const t of ['Live and Let Die', 'Track of My Tears', 'New', 'Audio', 'Voice of the Voiceless', '1979', '99 Luftballons', 'Titanium', 'Recording Angel', 'Zombie'])
      expect(motivo(t), t).toBeNull()
    // jingle e notiziari hanno nomi liberi
    expect(motivoNonRadiofonico(makeTrack({ title: 'Track 01', kind: 'jingle' }))).toBeNull()
  })
})

describe('doppioni', () => {
  it('stesso artista e titolo, senza maiuscole, accenti e "Remastered"', () => {
    const k = (title: string, artist: string): string => chiaveDoppione({ title, artist })
    expect(k('Perché no', 'Lucio Battisti')).toBe(k('PERCHE NO', 'lucio battisti'))
    expect(k('Heroes (2017 Remaster)', 'David Bowie')).toBe(k('Heroes', 'David Bowie'))
    expect(k('Heroes - 2017 Remastered', 'David Bowie')).toBe(k('Heroes', 'David Bowie'))
    expect(k('Rock & Roll', 'A')).toBe(k('Rock and Roll', 'A'))
    // remix e versioni diverse restano brani diversi
    expect(k('Heroes (Remix)', 'David Bowie')).not.toBe(k('Heroes', 'David Bowie'))
    expect(k('Senza artista', '')).toBe('')
  })

  it('tiene la copia con la qualità migliore, poi analizzata, poi la più lunga', () => {
    const a = makeTrack({ bitrate: 128, duration: 200 })
    const b = makeTrack({ bitrate: 320, duration: 190 })
    const c = makeTrack({ bitrate: 320, duration: 200, analyzedAt: '2026-01-01' })
    expect(copiaDaTenere([a, b, c]).id).toBe(c.id)
    expect(copiaDaTenere([a, b]).id).toBe(b.id)
  })

  it('il database raggruppa i doppioni con la copia da tenere per prima', () => {
    const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'dop-')), 'r.db'))
    db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'Heroes', artist: 'David Bowie', bitrate: 128 })
    const best = db.upsertScanned({ ...base, path: '/m/b.mp3', title: 'Heroes (2017 Remaster)', artist: 'David Bowie', bitrate: 320 })
    db.upsertScanned({ ...base, path: '/m/c.mp3', title: 'Altro', artist: 'David Bowie' })
    const d = db.doppioni()
    expect(d.total).toBe(1)
    expect(d.gruppi[0].tieni).toBe(best)
    expect(d.gruppi[0].tracks.map((t) => t.id)[0]).toBe(best)
    expect(d.gruppi[0].tracks).toHaveLength(2)
    // "va bene così" sulle copie: il gruppo sparisce
    db.segnaRadiofonico(d.gruppi[0].tracks.slice(1).map((t) => t.id))
    expect(db.doppioni().total).toBe(0)
  })
})

describe('togliere dalla libreria', () => {
  it('toglie senza toccare il file; la scansione non lo rimette; si può rimettere', () => {
    const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'pul-')), 'r.db'))
    const id = db.upsertScanned({ ...base, path: '/m/t.mp3', title: 'Track 01', artist: 'X' })
    db.upsertScanned({ ...base, path: '/m/ok.mp3', title: 'Canzone', artist: 'Y' })
    expect(db.daControllare().tracks.map((t) => [t.id, t.motivo])).toEqual([[id, expect.stringMatching(/generico/)]])
    expect(db.togliDallaLibreria([id])).toBe(1)
    expect(db.searchTracks({ text: 'Track' }).total).toBe(0)
    expect(db.daControllare().total).toBe(0)
    expect(db.toltiDallaLibreria().tracks.map((t) => t.id)).toEqual([id])
    // nuova scansione dello stesso file: resta fuori (scelta tua)
    db.refreshUnchanged('/m/t.mp3', 'music')
    db.upsertScanned({ ...base, path: '/m/t.mp3', title: 'Track 01', artist: 'X', mtime: 2 })
    expect(db.getTrack(id)?.enabled).toBe(false)
    // escluso anche dal server
    expect(db.musicForServer().find((r) => r.track.id === id)).toMatchObject({ missing: false, track: { enabled: false } })
    expect(db.rimettiInLibreria([id])).toBe(1)
    expect(db.getTrack(id)?.enabled).toBe(true)
  })

  it('"va bene così" toglie il brano dalla lista da controllare', () => {
    const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'pul-')), 'r.db'))
    const id = db.upsertScanned({ ...base, path: '/m/t.mp3', title: 'Track 1', artist: 'Band Track' })
    db.segnaRadiofonico([id])
    expect(db.daControllare().total).toBe(0)
    expect(db.getTrack(id)?.enabled).toBe(true)
  })

  it('sposta il file negli scarti della sua cartella musica e lo rimette a posto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scarti-'))
    const music = join(dir, 'Musica')
    mkdirSync(join(music, 'Rock'), { recursive: true })
    const file = join(music, 'Rock', 'Track 01.mp3')
    writeFileSync(file, 'x')
    const db = new RadioDb(join(dir, 'r.db'))
    db.addFolder(music, 'music')
    const id = db.upsertScanned({ ...base, path: file, title: 'Track 01', artist: 'X' })
    const r = await spostaNegliScarti(db, [id])
    expect(r).toEqual({ fatti: 1, errori: [] })
    const dest = join(music, CARTELLA_SCARTI, 'Rock', 'Track 01.mp3')
    expect(existsSync(file)).toBe(false)
    expect(existsSync(dest)).toBe(true)
    expect(db.getTrack(id)).toMatchObject({ path: dest, enabled: false })
    expect(db.toltiDallaLibreria().tracks[0].origPath).toBe(file)

    expect(await rimettiInLibreria(db, [id])).toEqual({ fatti: 1, errori: [] })
    expect(existsSync(file)).toBe(true)
    expect(existsSync(dest)).toBe(false)
    expect(db.getTrack(id)).toMatchObject({ path: file, enabled: true })
  })

  it('percorso degli scarti anche con i percorsi di Windows', () => {
    expect(percorsoScarto('C:\\Musica\\Rock\\a.mp3', ['c:\\musica'])).toMatch(/_Tolti dalla libreria/)
    expect(percorsoScarto('/altro/a.mp3', ['/musica'])).toBeNull()
    expect(percorsoScarto(`/musica/${CARTELLA_SCARTI}/a.mp3`, ['/musica'])).toBeNull()
  })
})

describe('filtri della libreria', () => {
  it('per titolo, artista, anno e ordine', () => {
    const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'fil-')), 'r.db'))
    db.upsertScanned({ ...base, path: '/m/1.mp3', title: 'Roma', artist: 'Venditti', year: 1990 })
    db.upsertScanned({ ...base, path: '/m/2.mp3', title: 'Venditti blues', artist: 'Altro', year: 2010 })
    db.upsertScanned({ ...base, path: '/m/3.mp3', title: 'Città', artist: 'Venditti', year: 2005 })
    expect(db.searchTracks({ artist: 'venditti' }).total).toBe(2)
    expect(db.searchTracks({ title: 'venditti' }).total).toBe(1)
    expect(db.searchTracks({ title: 'citta' }).tracks[0].title).toBe('Città')
    expect(db.searchTracks({ yearFrom: 2000 }).total).toBe(2)
    expect(db.searchTracks({ yearFrom: 2000, yearTo: 2006 }).tracks.map((t) => t.title)).toEqual(['Città'])
    expect(db.searchTracks({ sort: 'anno' }).tracks.map((t) => t.year)).toEqual([2010, 2005, 1990])
    expect(db.searchTracks({ sort: 'titolo' }).tracks[0].title).toBe('Città')
  })
})
