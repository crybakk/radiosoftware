import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import { exclusionReason, gainFor, onServer, planSync, serverId } from '../src/core/serverLibrary'
import { inWindow, ServerLibrarySync } from '../src/main/serverSync'
import type { LibraryMeta, PonteClient } from '../src/core/ponteClient'

const dir = mkdtempSync(join(tmpdir(), 'radio-srv-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const base = { kind: 'music' as const, genre: '', path: '/m/Rock/x.mp3', bitrate: 320, enabled: true }

describe('selezione per il server', () => {
  it('esclude live, interviste e bassa qualità; non tocca titoli come "Live Forever"', () => {
    const r = (o: Partial<typeof base> & { title: string }) => exclusionReason({ ...base, ...o }, 192)
    expect(r({ title: 'Albachiara (Live)' })).toBe('live (titolo)')
    expect(r({ title: 'Sally - Live at San Siro' })).toBe('live (titolo)')
    expect(r({ title: 'Vita spericolata [Live 1990]' })).toBe('live (titolo)')
    expect(r({ title: 'Generale (dal vivo)' })).toBe('live (titolo)')
    expect(r({ title: 'Live Forever' })).toBeNull()
    expect(r({ title: 'Live and Let Die' })).toBeNull()
    expect(r({ title: 'Alive' })).toBeNull()
    expect(r({ title: 'Oliver' })).toBeNull()
    expect(r({ title: 'Intervista a Vasco' })).toBe('intervista')
    expect(r({ title: 'Brano', genre: 'Live' })).toBe('live (genere)')
    expect(r({ title: 'Brano', path: 'D:\\Musica\\Concerti live\\Vasco\\a.mp3' })).toBe('live (cartella)')
    expect(r({ title: 'Brano', path: '/m/Interviste/a.mp3' })).toBe('intervista')
    expect(r({ title: 'Brano', bitrate: 128 })).toBe('qualità bassa (128 kbps)')
    expect(r({ title: 'Brano', bitrate: 0 })).toBeNull()
    // la scelta a mano vince
    expect(onServer({ ...base, title: 'Albachiara (Live)' }, true, 192)).toBe(true)
    expect(onServer({ ...base, title: 'Brano' }, false, 192)).toBe(false)
    expect(onServer({ ...base, kind: 'jingle', title: 'Brano' }, true, 192)).toBe(false)
  })

  it('percorso sul server dalla cartella della libreria', () => {
    const folders = [
      { id: 1, path: 'D:\\Musica', kind: 'music' as const },
      { id: 2, path: 'D:\\Musica\\Italiana', kind: 'music' as const },
      { id: 3, path: 'D:\\Jingle', kind: 'jingle' as const }
    ]
    expect(serverId('D:\\Musica\\Rock\\AC-DC\\a.mp3', folders)).toBe('regia/Musica/Rock/AC-DC/a.mp3')
    expect(serverId('d:\\musica\\italiana\\b.mp3', folders)).toBe('regia/Italiana/b.mp3')
    expect(serverId('D:\\Jingle\\j.mp3', folders)).toBeNull()
    expect(serverId('D:\\Musica\\.nascosta\\c.mp3', folders)).toBe('regia/Musica/_nascosta/c.mp3')
  })

  it('volume, ore di invio, piano', () => {
    expect(gainFor(-10, -16)).toBe(-6)
    expect(gainFor(null, -16)).toBe(0)
    expect(gainFor(-40, -16)).toBe(12)
    expect(inWindow(3, 1, 6)).toBe(true)
    expect(inWindow(6, 1, 6)).toBe(false)
    expect(inWindow(23, 22, 5)).toBe(true)
    expect(inWindow(12, 22, 5)).toBe(false)
    const t = {} as never
    expect(
      planSync(
        [
          { id: 'a', size: 1, track: t },
          { id: 'b', size: 2, track: t }
        ],
        [
          { id: 'a', size: 1 },
          { id: 'b', size: 5 },
          { id: 'c', size: 1 }
        ]
      )
    ).toEqual({ upload: [{ id: 'b', size: 2, track: t }], remove: ['c'] })
  })
})

class FakeClient {
  files = new Map<string, number>()
  meta: LibraryMeta[] = []
  uploads: string[] = []
  async listLibrary() {
    return [...this.files].map(([id, size]) => ({ id, size }))
  }
  async uploadLibraryFile(m: LibraryMeta, body: ReadableStream<Uint8Array>) {
    let n = 0
    for await (const c of body as unknown as AsyncIterable<Uint8Array>) n += c.length
    this.files.set(m.id, n)
    this.uploads.push(m.id)
  }
  async deleteLibraryFile(id: string) {
    this.files.delete(id)
  }
  async sendLibraryMeta(list: LibraryMeta[]) {
    this.meta.push(...list)
    return list.length
  }
  uploaded: { id: string; size: number; title: string; artist: string; duration: number; data: Uint8Array }[] = []
  moved: [string, string][] = []
  fps = new Map<string, number>()
  fpMeta: Record<string, unknown>[] = []
  async listUploaded() {
    return this.uploaded.map(({ data: _d, ...u }) => u)
  }
  async downloadUploaded(id: string) {
    const u = this.uploaded.find((x) => x.id === id)!
    return new Blob([u.data as Uint8Array<ArrayBuffer>]).stream()
  }
  async moveUploaded(from: string, to: string) {
    this.moved.push([from, to])
    this.uploaded = this.uploaded.filter((u) => u.id !== from)
  }
  async listFingerprints() {
    return [...this.fps].map(([id, n]) => ({ id, n }))
  }
  async uploadFingerprints(body: Uint8Array) {
    let o = 0
    let n = 0
    const dv = new DataView(body.buffer, body.byteOffset)
    while (o < body.length) {
      const len = dv.getUint32(o, true)
      const rec = body.subarray(o + 4, o + 4 + len)
      const nl = rec.indexOf(10)
      const meta = JSON.parse(new TextDecoder().decode(rec.subarray(0, nl)))
      this.fpMeta.push(meta)
      this.fps.set(meta.id, (len - nl - 1) / 4)
      o += 4 + len
      n++
    }
    return n
  }
  async deleteFingerprints(ids: string[]) {
    for (const id of ids) this.fps.delete(id)
  }
}

describe('copia della libreria sul server', () => {
  const music = join(dir, 'Musica')
  mkdirSync(join(music, 'Rock'), { recursive: true })
  const db = new RadioDb(':memory:')
  db.addFolder(music, 'music')
  const add = (name: string, title: string, bytes: number, bitrate = 320) => {
    const path = join(music, name)
    writeFileSync(path, Buffer.alloc(bytes, 1))
    const id = db.upsertScanned({
      path, kind: 'music', size: bytes, mtime: 1, title, artist: 'Vasco', album: '', year: 2000, genre: '',
      composer: '', publisher: '', isrc: '', duration: 200, bitrate, sampleRate: 44100
    })
    return id
  }
  add('Rock/a.mp3', 'Albachiara', 3 * 1024 * 1024)
  add('Rock/b.mp3', 'Sally (Live)', 1024)
  const lowId = add('c.mp3', 'Brano basso', 1024, 128)
  add('d.mp3', 'Vita spericolata', 2 * 1024 * 1024)

  it('copia su disco solo la selezione, con i percorsi del server', async () => {
    const sync = new ServerLibrarySync(db, dir, () => null, () => {})
    expect(sync.status()).toMatchObject({ selected: 2, excluded: 2 })
    const usb = join(dir, 'usb')
    expect(await sync.exportTo(usb)).toMatch(/Copiati 2 brani/)
    expect(existsSync(join(usb, 'regia', 'Musica', 'Rock', 'a.mp3'))).toBe(true)
    expect(existsSync(join(usb, 'regia', 'Musica', 'Rock', 'b.mp3'))).toBe(false)
    expect(await sync.exportTo(usb)).toMatch(/Copiati 0 brani.*2 già presenti/)
  })

  it('invia i nuovi entro il limite giornaliero, toglie gli esclusi, manda titoli e volumi', async () => {
    const c = new FakeClient()
    c.files.set('regia/Musica/d.mp3', 2 * 1024 * 1024) // già copiato a mano
    c.files.set('regia/Musica/vecchio.mp3', 10)
    db.saveSettings({ ponte: { ...db.getSettings().ponte, libraryDailyMb: 3 } })
    db.setServerChoice(lowId, true) // incluso a mano
    const sync = new ServerLibrarySync(db, dir, () => c as unknown as PonteClient, () => {})
    const res = await sync.syncNow(true)
    expect(c.files.has('regia/Musica/vecchio.mp3')).toBe(false)
    expect(c.uploads).toEqual(['regia/Musica/Rock/a.mp3']) // 3 MB: il secondo supererebbe il limite
    expect(res).toMatch(/Inviati 1 brani.*ne restano 1.*limite di 3 MB/)
    expect(c.meta.map((m) => m.id)).toEqual(['regia/Musica/d.mp3'])
    expect(JSON.parse(readFileSync(join(dir, 'libreria-server.json'), 'utf8')).bytes).toBe(3 * 1024 * 1024)
  })

  it('scarica i brani caricati dal pannello in Artista/Titolo e manda le impronte', async () => {
    const c = new FakeClient()
    db.saveSettings({ ponte: { ...db.getSettings().ponte, libraryDailyMb: 100 } })
    c.uploaded.push({ id: 'caricati/registrazione_01.mp3', size: 5, title: 'Canzone: nuova?', artist: 'Band Locale', duration: 180, data: new Uint8Array([1, 2, 3, 4, 5]) })
    // un brano con l'impronta, uno vecchio sul server da togliere
    const withFp = db.searchTracks({ text: 'Albachiara' }).tracks[0]
    db.saveFingerprint(withFp.id, new Uint8Array(16))
    c.fps.set('regia/Musica/sparito.mp3', 3)
    const catalogued: number[] = []
    const sync = new ServerLibrarySync(db, dir, () => c as unknown as PonteClient, () => {})
    sync.onCatalogued = (ids) => catalogued.push(...ids)
    const res = await sync.syncNow(true)
    const file = join(music, 'Band Locale', 'Canzone nuova.mp3')
    expect(readFileSync(file)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(c.moved).toEqual([['caricati/registrazione_01.mp3', 'regia/Musica/Band Locale/Canzone nuova.mp3']])
    const t = db.findByPath(file)!
    expect(t).toMatchObject({ kind: 'music', title: 'Canzone: nuova?', artist: 'Band Locale' })
    expect(catalogued).toEqual([t.id])
    expect(res).toMatch(/Scaricati e catalogati 1 brani/)
    expect([...c.fps]).toEqual([['regia/Musica/Rock/a.mp3', 4]])
    expect(c.fpMeta[0]).toMatchObject({ title: 'Albachiara', artist: 'Vasco' })
    // la volta dopo non si rimanda nulla
    expect(await sync.syncNow(true)).not.toMatch(/impronte/)
  })

  it('non svuota il server se la libreria sembra scollegata', async () => {
    const c = new FakeClient()
    for (let i = 0; i < 100; i++) c.files.set(`regia/Musica/x${i}.mp3`, 1)
    const sync = new ServerLibrarySync(db, dir, () => c as unknown as PonteClient, () => {})
    await expect(sync.syncNow(true)).rejects.toThrow(/toglierebbe 100 brani/)
    expect(c.files.size).toBe(100)
  })
})
