import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import { expandEvent, parsePlaylist, pickReplay } from '../src/core/eventActions'
import { applyProfile } from '../src/core/rotationService'
import type { EventAction, ScheduledEvent } from '../src/core/types'
import { makeTrack } from './helpers'

const dir = mkdtempSync(join(tmpdir(), 'radio-ev-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function add(db: RadioDb, path: string, kind: 'music' | 'jingle', genre = '') {
  return db.upsertScanned({
    path, kind, size: 1, mtime: 1, title: path, artist: 'A', album: '', year: 2000, genre,
    composer: '', publisher: '', isrc: '', duration: 100, bitrate: 192, sampleRate: 44100
  })
}
const ev = (actions: EventAction[]): ScheduledEvent => ({
  id: 1, label: 'Prova', time: '10:00', days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null,
  validFrom: null, validTo: null, mode: 'soft', toleranceSeconds: 0, actions, enabled: true
})

describe('azioni degli eventi', () => {
  it('legge playlist M3U e PLS con percorsi relativi', () => {
    expect(parsePlaylist('#EXTM3U\n#EXTINF:1,x\na.mp3\n/abs/b.mp3\nhttp://x/stream\n', '/pl/list.m3u')).toEqual([
      '/pl/a.mp3',
      '/abs/b.mp3'
    ])
    expect(parsePlaylist('[playlist]\nFile1=c.mp3\nTitle1=x\nNumberOfEntries=1', '/pl/l.pls')).toEqual(['/pl/c.mp3'])
    expect(parsePlaylist('C:\\Musica\\d.mp3', '/pl/l.m3u')).toEqual(['C:\\Musica\\d.mp3'])
  })

  it('esegue brano, casuale, flusso, playlist e controlli nell\'ordine giusto', async () => {
    const db = new RadioDb(':memory:')
    const song = add(db, '/m/song.mp3', 'music')
    add(db, '/j/ora1.mp3', 'jingle')
    add(db, '/m/pl1.mp3', 'music')
    add(db, '/m/pl2.mp3', 'music')
    const pl = join(dir, 'lista.m3u')
    writeFileSync(pl, '/m/pl1.mp3\n/m/pl2.mp3\n/m/manca.mp3\n')
    const commands: string[] = []
    const steps = await expandEvent(
      db,
      ev([
        { type: 'random', kind: 'jingle', folder: '', genre: '' },
        { type: 'play', trackId: song },
        { type: 'stream', url: 'https://radio.example/live', minutes: 30, title: 'Radio partner' },
        { type: 'playlist', path: pl, placement: 'append' },
        { type: 'mode', mode: 'auto' },
        { type: 'command', command: 'echo ciao' },
        { type: 'rotation', profile: { name: 'Sera', genres: ['jazz'], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: 0 } }
      ]),
      { now: () => new Date(), runCommand: (c) => commands.push(c) }
    )
    expect(steps[0]).toMatchObject({ kind: 'tracks', placement: 'front' })
    const front = (steps[0] as { tracks: { path: string; duration: number }[] }).tracks
    expect(front.map((t) => t.path)).toEqual(['/j/ora1.mp3', '/m/song.mp3', 'https://radio.example/live'])
    expect(front[2].duration).toBe(1800)
    expect(steps[1]).toMatchObject({ kind: 'tracks', placement: 'append' })
    expect((steps[1] as { tracks: unknown[] }).tracks).toHaveLength(2)
    expect(steps[2]).toMatchObject({ kind: 'error', message: '1 file della playlist non trovati' })
    expect(steps[3]).toEqual({ kind: 'mode', mode: 'auto' })
    expect(commands).toEqual(['echo ciao'])
    expect(db.getSettings().rotationProfile?.name).toBe('Sera')
    db.close()
  })

  it('replica: ultima puntata del programma dal server', async () => {
    const programs = [
      {
        id: 'sera',
        title: 'La sera',
        episodes: [
          { id: 'e2', title: 'Puntata 2', length: 3540.4, path: 'https://radio.test/api/station/radio/public/podcast/sera/episode/e2/download.mp3' },
          { id: 'e1', title: 'Puntata 1', length: 1800, path: 'https://radio.test/e1.mp3' }
        ]
      },
      { id: 'vuoto', title: 'Vuoto', episodes: [] }
    ]
    const t = pickReplay(programs, 'sera')!
    expect(t).toMatchObject({ kind: 'program', title: 'Replica: Puntata 2', artist: 'La sera', duration: 3540, cueOut: 3540, path: programs[0].episodes[0].path })
    expect(t.id).toBeLessThan(0)
    expect(pickReplay(programs, 'sera', 'e1')!.duration).toBe(1800)
    expect(pickReplay(programs, 'vuoto')).toBeNull()
    expect(pickReplay(programs, 'altro')).toBeNull()

    const db = new RadioDb(':memory:')
    const fx = { now: () => new Date(), runCommand: () => {}, replay: async (id: string) => pickReplay(programs, id) }
    const ok = await expandEvent(db, ev([{ type: 'replay', programId: 'sera', title: 'La sera' }]), fx)
    expect((ok[0] as { tracks: { title: string }[] }).tracks[0].title).toBe('Replica: Puntata 2')
    const none = await expandEvent(db, ev([{ type: 'replay', programId: 'vuoto', title: 'Vuoto' }]), fx)
    expect(none[0]).toMatchObject({ kind: 'error', message: 'replica di "Vuoto" non disponibile: nessuna puntata pubblicata' })
    const offline = await expandEvent(db, ev([{ type: 'replay', programId: 'sera', title: 'La sera' }]), {
      ...fx,
      replay: async () => {
        throw new Error('ponte non raggiungibile')
      }
    })
    expect(offline[0]).toMatchObject({ kind: 'error', message: 'replica di "La sera" non disponibile: ponte non raggiungibile' })
    db.close()
  })

  it('brano casuale per genere e cartella', () => {
    const db = new RadioDb(':memory:')
    add(db, '/a/x.mp3', 'music', 'Rock')
    add(db, '/b/y.mp3', 'music', 'Jazz, Swing')
    expect(db.randomTrack({ genre: 'jazz' })!.path).toBe('/b/y.mp3')
    expect(db.randomTrack({ folder: '/a/' })!.path).toBe('/a/x.mp3')
    expect(db.randomTrack({ kind: 'jingle' })).toBeNull()
    expect(db.listGenres()).toEqual(['Jazz', 'Rock', 'Swing'])
    db.close()
  })

  it('il profilo di rotazione filtra ma non svuota la radio', () => {
    const tracks = Array.from({ length: 30 }, (_, i) => makeTrack({ genre: i < 12 ? 'Jazz' : 'Pop', year: 1990 + i }))
    const profile = { name: '', genres: ['jazz'], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null }
    expect(applyProfile(tracks, profile)).toHaveLength(12)
    expect(applyProfile(tracks, { ...profile, yearFrom: 2000 })).toHaveLength(30)
  })
})
