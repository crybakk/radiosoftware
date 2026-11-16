import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import { MusicBrainz } from '../src/core/musicbrainz'
import { MusicBrainzService } from '../src/main/musicbrainz'

describe('ricerca dei generi su MusicBrainz', () => {
  it('rilegge le registrazioni già trovate, non ricerca quelle non trovate, generi dell\'artista una volta sola', async () => {
    const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'mbs-')), 'r.db'))
    const base = { kind: 'music' as const, size: 1, mtime: 1, album: '', genre: '', year: null, duration: 200, bitrate: 320, sampleRate: 44100, composer: 'C', publisher: 'E', isrc: 'I' }
    const ids = ['A', 'B', 'C'].map((t) => db.upsertScanned({ ...base, path: `/m/${t}.mp3`, title: t, artist: 'X' }))
    db.saveMb(ids[0], 'rec-a', {})
    db.saveMb(ids[1], 'rec-b', {})
    db.saveMb(ids[2], '', {})
    for (const id of ids) db.db.prepare("UPDATE tracks SET iswc = 'T', mb_genres_at = NULL WHERE id = ?").run(id)
    const urls: string[] = []
    const mb = new MusicBrainz({
      sleep: async () => {},
      fetch: async (u) => {
        urls.push(u.replace('https://musicbrainz.org/ws/2/', '').replace(/\?.*/, ''))
        if (u.includes('/artist/')) return Response.json({ genres: [{ name: 'Cantautorato', count: 3 }] })
        const id = /recording\/([^?]+)/.exec(u)![1]
        return Response.json({ id, genres: [], 'artist-credit': [{ name: 'X', artist: { id: 'art-x', name: 'X' } }] })
      }
    })
    const svc = new MusicBrainzService(db, () => {}, mb)
    await svc.start()
    expect(urls).toEqual(['recording/rec-a', 'artist/art-x', 'recording/rec-b'])
    expect(ids.map((id) => db.getTrack(id)!.mbGenres)).toEqual(['cantautorato', 'cantautorato', ''])
    expect(svc.status().todo).toBe(0)
    db.close()
  })
})
