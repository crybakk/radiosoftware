import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcoustId } from '../src/core/acoustid'
import { RadioDb } from '../src/core/db'
import { MusicBrainz, pickRecording } from '../src/core/musicbrainz'
import { MusicBrainzService } from '../src/main/musicbrainz'
import { tagWorkers } from '../src/main/tagServices'
import { LastFm } from '../src/core/lastfm'

const fast = { sleep: async () => {} }
const tmp = () => mkdtempSync(join(tmpdir(), 'mbr-'))
const base = { kind: 'music' as const, size: 1, mtime: 1, album: '', genre: '', year: null, duration: 200, bitrate: 320, sampleRate: 44100, composer: '', publisher: '', isrc: '' }
const credit = (name: string) => [{ name, artist: { name } }]
/** fpcalc finto che dà sempre la stessa impronta. */
function fakeFpcalc(): string {
  const f = join(tmp(), 'fpcalc')
  writeFileSync(f, '#!/bin/sh\necho \'{"duration": 200, "fingerprint": "AQ"}\'\n')
  chmodSync(f, 0o755)
  return f
}
/** MusicBrainz che non trova mai niente per titolo. */
const mbNone = () => new MusicBrainz({ ...fast, fetch: async () => Response.json({ recordings: [] }) })

describe('MusicBrainz: casi limite', () => {
  it('"and", "&" e la virgola tra gli artisti non impediscono di trovare il brano', () => {
    const rec = (artist: string) => [{ id: 'ok', score: 100, title: 'The Boxer', length: 300_000, 'artist-credit': credit(artist) }]
    expect(pickRecording(rec('Simon & Garfunkel'), { title: 'The Boxer', artist: 'Simon and Garfunkel', duration: 300 })?.id).toBe('ok')
    expect(pickRecording(rec('Jovanotti & Fiorello'), { title: 'The Boxer', artist: 'Jovanotti, Fiorello', duration: 300 })?.id).toBe('ok')
    // un altro artista resta un altro artista
    expect(pickRecording(rec('Simon & Garfunkel'), { title: 'The Boxer', artist: 'Simon', duration: 300 })?.id).toBe('ok')
    expect(pickRecording(rec('Paul Simon'), { title: 'The Boxer', artist: 'Simon and Garfunkel', duration: 300 })).toBeNull()
  })

  it('"Ferma" interrompe subito l\'attesa dopo un 503, senza restare in corso', async () => {
    const db = new RadioDb(join(tmp(), 'r.db'))
    db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'A', artist: 'X' })
    let fetched = 0
    const mb = new MusicBrainz({
      // un'attesa che non finisce mai da sola
      sleep: () => new Promise(() => {}),
      now: () => 1e12 + fetched * 10_000,
      fetch: async () => {
        fetched++
        setTimeout(() => svc.stop(), 0)
        return new Response('', { status: 503 })
      }
    })
    const svc = new MusicBrainzService(db, () => {}, mb)
    const done = await Promise.race([svc.start().then(() => 'fermata'), new Promise((r) => setTimeout(() => r('bloccata'), 500))])
    expect(done).toBe('fermata')
    expect(svc.status().running).toBe(false)
    db.close()
  })

  it('la chiave sbagliata di AcoustID (risposta 400) ferma la ricerca con un messaggio chiaro', async () => {
    const db = new RadioDb(join(tmp(), 'r.db'))
    for (const t of ['A', 'B', 'C']) db.upsertScanned({ ...base, path: `/m/${t}.mp3`, title: t, artist: 'X' })
    let acoustCalls = 0
    const client = new AcoustId(() => 'sbagliata', {
      ...fast,
      fetch: async () => {
        acoustCalls++
        return Response.json({ status: 'error', error: { code: 4, message: 'invalid API key' } }, { status: 400 })
      }
    })
    const svc = new MusicBrainzService(db, () => {}, mbNone(), { client, enabled: () => true, fpcalc: fakeFpcalc })
    await svc.start()
    expect(svc.status().lastError).toMatch(/AcoustID: chiave non valida/)
    expect(acoustCalls).toBe(1)
    db.close()
  })

  it('un\'impronta rifiutata da AcoustID per un file rovinato non blocca la ricerca', async () => {
    const client = new AcoustId(() => 'k', {
      ...fast,
      fetch: async () => Response.json({ status: 'error', error: { code: 3, message: 'invalid fingerprint' } }, { status: 400 })
    })
    await expect(client.recording({ fingerprint: 'xx', duration: 200 })).resolves.toBeNull()
  })

  it('fpcalc che non parte non segna tutti i brani come già provati con AcoustID', async () => {
    const db = new RadioDb(join(tmp(), 'r.db'))
    const ids = ['A', 'B'].map((t) => db.upsertScanned({ ...base, path: `/m/${t}.mp3`, title: t, artist: 'X' }))
    const client = new AcoustId(() => 'k', { ...fast, fetch: async () => Response.json({ status: 'ok', results: [] }) })
    const svc = new MusicBrainzService(db, () => {}, mbNone(), { client, enabled: () => true, fpcalc: () => join(tmp(), 'fpcalc-che-non-esiste') })
    await svc.start()
    expect(svc.status().lastError).toMatch(/fpcalc/)
    // restano da provare dall'audio quando fpcalc funziona
    expect(db.mbPending(20, true).map((t) => [t.id, t.acoustIdTried])).toEqual(ids.map((id) => [id, false]))
    db.close()
  })

  it('"Ferma" durante l\'impronta non segna il brano come provato con AcoustID', async () => {
    const db = new RadioDb(join(tmp(), 'r.db'))
    const id = db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'A', artist: 'X' })
    const mb = new MusicBrainz({
      ...fast,
      fetch: async () => {
        svc.stop()
        return Response.json({ recordings: [] })
      }
    })
    const client = new AcoustId(() => 'k', { ...fast, fetch: async () => Response.json({ status: 'ok', results: [] }) })
    const svc = new MusicBrainzService(db, () => {}, mb, { client, enabled: () => true, fpcalc: () => process.execPath })
    await svc.start()
    expect(db.mbTrack(id)!.acoustIdTried).toBe(false)
    db.close()
  })

  it('un brano riscaricato dal server rilegge la registrazione già trovata invece di perderla', async () => {
    const db = new RadioDb(join(tmp(), 'r.db'))
    const id = db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'Titolo scritto male', artist: 'X' })
    db.saveMb(id, 'rec-a', { genres: ['pop'] })
    db.mbRequeue(id)
    const urls: string[] = []
    const mb = new MusicBrainz({
      ...fast,
      fetch: async (u) => {
        urls.push(u.replace(/\?.*/, ''))
        if (u.includes('/recording?')) return Response.json({ recordings: [] })
        return Response.json({ id: 'rec-a', genres: [{ name: 'pop', count: 1 }] })
      }
    })
    const svc = new MusicBrainzService(db, () => {}, mb)
    await svc.lookup([id])
    expect(urls).toEqual(['https://musicbrainz.org/ws/2/recording/rec-a'])
    expect(db.mbTrack(id)!.recordingId).toBe('rec-a')
    db.close()
  })

  it('"Ferma" su Last.fm interrompe subito l\'attesa dopo un 503', async () => {
    const db = new RadioDb(join(tmp(), 'r.db'))
    db.upsertScanned({ ...base, path: '/m/a.mp3', title: 'A', artist: 'X' })
    db.saveSettings({ lastfmKey: 'k' })
    const lastfm = new LastFm(() => 'k', {
      sleep: () => new Promise(() => {}),
      fetch: async () => {
        setTimeout(() => lfm.stop(), 0)
        return new Response('', { status: 503 })
      }
    })
    const [, lfm] = tagWorkers(db, () => {}, { lastfm })
    const done = await Promise.race([lfm.start().then(() => 'fermata'), new Promise((r) => setTimeout(() => r('bloccata'), 500))])
    expect(done).toBe('fermata')
    db.close()
  })
})
