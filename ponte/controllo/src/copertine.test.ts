import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoverArt, coverKey, fromDeezer, fromItunes, isImage, sameArtist } from './copertine.ts'

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)])

function fakeFetch(routes: Record<string, unknown>, calls: string[]) {
  return async (url: string) => {
    calls.push(url)
    const host = new URL(url).host
    const body = routes[host]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      arrayBuffer: async () => {
        const b = body as Buffer
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer
      }
    }
  }
}

describe('copertine dei brani', () => {
  it('legge i risultati di iTunes e Deezer solo se l\'artista corrisponde', () => {
    const it1 = { results: [{ artistName: 'Altro', artworkUrl100: 'https://a/x/100x100bb.jpg' }, { artistName: 'Vasco Rossi', artworkUrl100: 'https://a/y/100x100bb.jpg' }] }
    expect(fromItunes(it1, 'vasco rossi')).toBe('https://a/y/600x600bb.jpg')
    expect(fromItunes(it1, 'Ligabue')).toBeNull()
    expect(fromItunes({}, 'x')).toBeNull()
    const dz = { data: [{ artist: { name: 'Lucio Dalla' }, album: { cover_xl: 'https://d/c.jpg' } }] }
    expect(fromDeezer(dz, 'Lucio Dalla & Francesco De Gregori')).toBe('https://d/c.jpg')
    expect(fromDeezer(dz, 'Battiato')).toBeNull()
    expect(sameArtist('Fabrizio De André', 'fabrizio de andre')).toBe(true)
    expect(sameArtist('', 'x')).toBe(false)
    expect(coverKey('Vasco ROSSI', 'Albachiara!')).toBe(coverKey('vasco rossi', 'albachiara'))
    expect(isImage(JPEG)).toBe(true)
    expect(isImage(Buffer.from('<html>'))).toBe(false)
  })

  it('cerca su iTunes, poi su Deezer; salva e non ricerca una seconda volta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copertine-'))
    const calls: string[] = []
    const c = new CoverArt(
      dir,
      fakeFetch({ 'itunes.apple.com': { results: [] }, 'api.deezer.com': { data: [{ artist: { name: 'Vasco Rossi' }, album: { cover_xl: 'https://img.test/c.jpg' } }] }, 'img.test': JPEG }, calls)
    )
    expect(c.ready('Vasco Rossi', 'Albachiara')).toBeNull()
    const [a, b] = await Promise.all([c.lookup('Vasco Rossi', 'Albachiara'), c.lookup('Vasco Rossi', 'Albachiara')])
    expect(a && b).toBe(true)
    expect(calls.map((u) => new URL(u).host)).toEqual(['itunes.apple.com', 'api.deezer.com', 'img.test'])
    const key = c.ready('Vasco Rossi', 'Albachiara')!
    expect(readFileSync(c.file(key)).equals(JPEG)).toBe(true)
    expect(await c.lookup('Vasco Rossi', 'Albachiara')).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it('niente copertina o immagine non valida: non salva e non riprova per un giorno', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copertine-'))
    const calls: string[] = []
    let t = 0
    const c = new CoverArt(dir, fakeFetch({ 'itunes.apple.com': { results: [{ artistName: 'X', artworkUrl100: 'https://img.test/100x100bb.jpg' }] }, 'img.test': Buffer.from('<html>non è un\'immagine</html>') }, calls), () => t)
    expect(await c.lookup('X', 'Y')).toBe(false)
    expect(existsSync(c.file(coverKey('X', 'Y')))).toBe(false)
    const n = calls.length
    expect(await c.lookup('X', 'Y')).toBe(false)
    expect(calls).toHaveLength(n)
    t = 25 * 3600_000
    await c.lookup('X', 'Y')
    expect(calls.length).toBeGreaterThan(n)
    // senza artista o titolo non si cerca
    expect(await c.lookup('', 'Y')).toBe(false)
  })
})
