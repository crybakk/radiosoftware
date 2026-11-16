import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcoustId, pickAcoustId } from '../src/core/acoustid'
import { RadioDb } from '../src/core/db'
import { Discogs, discogsSearchUrl, pickDiscogs } from '../src/core/discogs'
import { LastFm, pickTags } from '../src/core/lastfm'
import { MusicBrainz } from '../src/core/musicbrainz'
import { MusicBrainzService } from '../src/main/musicbrainz'
import { tagWorkers } from '../src/main/tagServices'

const fast = { sleep: async () => {} }
const tmp = () => mkdtempSync(join(tmpdir(), 'tag-'))
const base = { kind: 'music' as const, size: 1, mtime: 1, album: '', genre: '', year: null, duration: 200, bitrate: 320, sampleRate: 44100, composer: '', publisher: '', isrc: '' }

describe('Discogs', () => {
  it('prende generi e stili del primo risultato dello stesso interprete', () => {
    expect(discogsSearchUrl('Vasco Rossi', 'Albachiara')).toContain('artist=Vasco+Rossi&track=Albachiara')
    const r = [
      { title: 'Altro - Cover', genre: ['Pop'] },
      { title: 'Vasco Rossi - Non Siamo Mica Gli Americani!', genre: ['Rock'], style: ['Pop Rock', 'Rock'] }
    ]
    expect(pickDiscogs(r, 'Vasco Rossi')).toEqual(['rock', 'pop rock'])
    expect(pickDiscogs(r, 'Nessuno')).toBeNull()
  })

  it('manda il token e segnala la chiave sbagliata', async () => {
    let auth = ''
    const d = new Discogs(() => 'TOK', { ...fast, fetch: async (_u, i) => ((auth = (i.headers as Record<string, string>).Authorization), Response.json({ results: [] })) })
    expect(await d.genres({ artist: 'A', title: 'B' })).toBeNull()
    expect(auth).toBe('Discogs token=TOK')
    const bad = new Discogs(() => 'x', { ...fast, fetch: async () => new Response('', { status: 401 }) })
    await expect(bad.genres({ artist: 'A', title: 'B' })).rejects.toThrow(/chiave non valida/)
  })
})

describe('Last.fm', () => {
  it('tiene le etichette più usate, senza quelle personali e il nome dell\'artista', () => {
    const tags = [
      { name: 'Italian', count: 100 },
      { name: 'seen live', count: 80 },
      { name: 'Vasco Rossi', count: 70 },
      { name: '80s', count: '40' },
      { name: 'rara', count: 3 }
    ]
    expect(pickTags(tags, 'Vasco Rossi')).toEqual(['italian', '80s'])
  })

  it('riconosce gli errori che Last.fm manda con la risposta 200', async () => {
    const lf = (body: object) => new LastFm(() => 'K', { ...fast, fetch: async () => Response.json(body) })
    expect(await lf({ error: 6, message: 'Track not found' }).trackTags({ artist: 'A', title: 'B' })).toEqual([])
    await expect(lf({ error: 10, message: 'Invalid API key' }).trackTags({ artist: 'A', title: 'B' })).rejects.toThrow(/chiave non valida/)
    expect(await lf({ toptags: { tag: { name: 'Jazz', count: 100 } } }).artistTags('X')).toEqual(['jazz'])
  })
})

describe('AcoustID', () => {
  it('sceglie la registrazione sicura con la durata simile', () => {
    const res = [
      { score: 0.5, recordings: [{ id: 'debole', duration: 200 }] },
      { score: 0.95, recordings: [{ id: 'lontana', duration: 260 }, { id: 'giusta', duration: 203 }] }
    ]
    expect(pickAcoustId(res, 200)).toBe('giusta')
    expect(pickAcoustId([{ score: 0.9, recordings: [{ id: 'x', duration: 100 }] }], 200)).toBeNull()
  })

  it('segnala la chiave sbagliata', async () => {
    const a = new AcoustId(() => 'k', { ...fast, fetch: async () => Response.json({ status: 'error', error: { code: 4, message: 'invalid API key' } }) })
    await expect(a.recording({ fingerprint: 'AQ', duration: 200 })).rejects.toThrow(/chiave non valida/)
  })
})

describe('ricerca in background su Discogs e Last.fm', () => {
  it('salva i generi, usa le etichette dell\'artista una volta sola e si ferma senza chiave', async () => {
    const db = new RadioDb(join(tmp(), 'r.db'))
    const ids = ['Uno', 'Due'].map((t) => db.upsertScanned({ ...base, path: `/m/${t}.mp3`, title: t, artist: 'Artista' }))
    const calls: string[] = []
    const fetch = async (u: string) => {
      calls.push(u.includes('discogs') ? 'dc' : /method=([a-z.]+)/.exec(u)![1])
      if (u.includes('discogs')) return Response.json({ results: [{ title: 'Artista - Album', genre: ['Pop'], style: ['Ballad'] }] })
      if (u.includes('track.gettoptags')) return Response.json({ toptags: { tag: [] } })
      return Response.json({ toptags: { tag: [{ name: 'Cantautori', count: 100 }] } })
    }
    const ws = tagWorkers(db, () => {}, { discogs: new Discogs(() => 't', { ...fast, fetch }), lastfm: new LastFm(() => 'k', { ...fast, fetch }) })
    const [dc, lfm] = ws
    await dc.start()
    expect(dc.status()).toMatchObject({ configured: false, lastError: expect.stringMatching(/manca la chiave/) })
    db.saveSettings({ discogsToken: 'tok', lastfmKey: 'key' })
    await dc.start()
    await lfm.start()
    expect(ids.map((id) => [db.getTrack(id)!.dcGenres, db.getTrack(id)!.lfmTags])).toEqual([
      ['pop, ballad', 'cantautori'],
      ['pop, ballad', 'cantautori']
    ])
    expect(calls).toEqual(['dc', 'dc', 'track.gettoptags', 'artist.gettoptags', 'track.gettoptags'])
    expect(lfm.status()).toMatchObject({ todo: 0, checked: 2, found: 2 })
    expect(db.listGenres()).toEqual(['ballad', 'cantautori', 'pop'])
    db.close()
  })
})

describe('MusicBrainz con AcoustID', () => {
  it('cerca dall\'audio i brani non trovati per titolo, una volta sola', async () => {
    const dir = tmp()
    const fpcalc = join(dir, 'fpcalc')
    writeFileSync(fpcalc, '#!/bin/sh\necho \'{"duration": 200.5, "fingerprint": "AQADtest"}\'\n')
    chmodSync(fpcalc, 0o755)
    const db = new RadioDb(join(dir, 'r.db'))
    const id = db.upsertScanned({ ...base, path: '/m/x.mp3', title: 'Titolo sbagliato', artist: 'Ignoto' })
    const urls: string[] = []
    const mb = new MusicBrainz({
      ...fast,
      fetch: async (u) => {
        urls.push(u.replace(/\?.*/, ''))
        if (u.includes('/recording?')) return Response.json({ recordings: [] })
        return Response.json({ id: 'rec-audio', genres: [{ name: 'pop', count: 1 }], isrcs: ['IT1'] })
      }
    })
    const acoustFetch = async (u: string) => {
      urls.push(`acoustid ${new URL(u).searchParams.get('fingerprint')}`)
      return Response.json({ status: 'ok', results: [{ score: 0.97, recordings: [{ id: 'rec-audio', duration: 201 }] }] })
    }
    const svc = new MusicBrainzService(db, () => {}, mb, { client: new AcoustId(() => 'k', { ...fast, fetch: acoustFetch }), enabled: () => true, fpcalc: () => fpcalc })
    await svc.start()
    expect(db.getTrack(id)).toMatchObject({ isrc: 'IT1', mbGenres: 'pop' })
    expect(urls).toEqual(['https://musicbrainz.org/ws/2/recording', 'acoustid AQADtest', 'https://musicbrainz.org/ws/2/recording/rec-audio'])
    expect(svc.status()).toMatchObject({ todo: 0, acoustId: true })
    db.close()
  })
})
