import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import { afterAll, describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import { exclusionReason, gainFor, onServer, planSync, serverId, tooLong } from '../src/core/serverLibrary'
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

  it('i brani più lunghi della durata massima (premixati) non vanno mai sul server, neanche scelti a mano', () => {
    expect(tooLong({ kind: 'music', duration: 601 }, 10)).toBe(true)
    expect(tooLong({ kind: 'music', duration: 600 }, 10)).toBe(false)
    expect(tooLong({ kind: 'music', duration: 0 }, 10)).toBe(false)
    expect(tooLong({ kind: 'music', duration: 3600 }, 0)).toBe(false)
    expect(tooLong({ kind: 'news', duration: 3600 }, 10)).toBe(false)
    expect(onServer({ ...base, title: 'Mix estate', duration: 3600 }, true, 192, 10)).toBe(false)
    expect(onServer({ ...base, title: 'Mix estate', duration: 3600 }, null, 192, 0)).toBe(true)
    expect(onServer({ ...base, title: 'Brano', duration: 240 }, null, 192, 10)).toBe(true)
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
    // i brani da tenere non si tolgono
    expect(planSync([], [{ id: 'c', size: 1 }, { id: 'd', size: 1 }], (id) => id === 'c').remove).toEqual(['d'])
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
    // un mp3 vero (il catalogo scarta i file che non contengono audio) e uno rovinato, che va saltato
    const audio = execFileSync(ffmpegStatic as unknown as string, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'mp3', 'pipe:1'])
    c.uploaded.push({ id: 'caricati/rotto.mp3', size: 5, title: 'Rotto', artist: 'Nessuno', duration: 0, data: new Uint8Array([1, 2, 3, 4, 5]) })
    c.uploaded.push({ id: 'caricati/registrazione_01.mp3', size: audio.length, title: 'Canzone: nuova?', artist: 'Band Locale', duration: 180, data: new Uint8Array(audio) })
    // un brano con l'impronta, uno vecchio sul server da togliere
    const withFp = db.searchTracks({ text: 'Albachiara' }).tracks[0]
    db.saveFingerprint(withFp.id, new Uint8Array(16))
    c.fps.set('regia/Musica/sparito.mp3', 3)
    const catalogued: number[] = []
    const sync = new ServerLibrarySync(db, dir, () => c as unknown as PonteClient, () => {})
    sync.onCatalogued = (ids) => catalogued.push(...ids)
    const res = await sync.syncNow(true)
    const file = join(music, 'Band Locale', 'Canzone nuova.mp3')
    expect(readFileSync(file)).toEqual(audio)
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

  it('oltre 20 brani da togliere non toglie nulla finché non confermi, poi li toglie una volta', async () => {
    const c = new FakeClient()
    for (let i = 0; i < 21; i++) c.files.set(`regia/Musica/x${i}.mp3`, 1)
    const sync = new ServerLibrarySync(db, dir, () => c as unknown as PonteClient, () => {})
    expect(await sync.syncNow(true)).toMatch(/21 brani da togliere dal server aspettano la tua conferma/)
    expect([...c.files.keys()].filter((id) => id.includes('/x')).length).toBe(21)
    expect(sync.status().toConfirmRemove).toBe(21)
    // un brano rimesso sul server nel frattempo dalla regia non si toglie
    c.files.delete('regia/Musica/x0.mp3')
    expect(await sync.confirmRemovals()).toMatch(/Tolti dal server 20 brani \(1 non più da togliere\)/)
    expect([...c.files.keys()].filter((id) => id.includes('/x'))).toEqual([])
    expect(sync.status().toConfirmRemove).toBe(0)
    expect(await sync.confirmRemovals()).toMatch(/Nessun brano/)
    // fino a 20 si tolgono senza chiedere
    for (let i = 0; i < 20; i++) c.files.set(`regia/Musica/y${i}.mp3`, 1)
    expect(await sync.syncNow(true)).toMatch(/tolti 20/)
    expect(sync.status().toConfirmRemove).toBe(0)
  })
})

describe('nomi dei brani scaricati dal server', () => {
  it('nomi riservati di Windows anche con estensione, punti in fondo dopo il taglio, estensioni strane', async () => {
    const { catalogParts, safeFileName } = await import('../src/core/catalog')
    expect(safeFileName('CON', 'x')).toBe('CON_')
    expect(safeFileName('nul.live', 'x')).toBe('nul_.live')
    expect(safeFileName('Com1 .remix', 'x')).toBe('Com1_ .remix')
    expect(safeFileName('Conte', 'x')).toBe('Conte')
    expect(catalogParts({ id: 'caricati/a.mp3', title: 'Aux', artist: 'Prn' })).toEqual(['Prn_', 'Aux_.mp3'])
    // il taglio a 120 caratteri non lascia un punto in fondo né mezza emoji
    const long = safeFileName(`${'a'.repeat(119)}.b`, 'x')
    expect(long).toBe('a'.repeat(119))
    const emoji = safeFileName(`${'a'.repeat(119)}😀😀`, 'x')
    expect(emoji).toBe(`${'a'.repeat(119)}😀`)
    expect(catalogParts({ id: 'caricati/a.mp3:flusso', title: 'T', artist: 'A' })[1]).toBe('T.mp3')
  })
})

describe('invio al server: casi difficili', () => {
  const base2 = mkdtempSync(join(dir, 'casi-'))
  const add = (db: RadioDb, path: string, title: string, bytes: number, bitrate = 320) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, Buffer.alloc(bytes, 1))
    return db.upsertScanned({
      path, kind: 'music', size: bytes, mtime: 1, title, artist: 'Vasco', album: '', year: 2000, genre: '',
      composer: '', publisher: '', isrc: '', duration: 200, bitrate, sampleRate: 44100
    })
  }

  it('due cartelle con lo stesso nome non si ricaricano a vicenda ogni notte', async () => {
    const db = new RadioDb(':memory:')
    const a = join(base2, 'D', 'Musica')
    const b = join(base2, 'E', 'Musica')
    db.addFolder(a, 'music')
    db.addFolder(b, 'music')
    add(db, join(a, 'x.mp3'), 'Uno', 10)
    add(db, join(b, 'x.mp3'), 'Due', 20)
    const c = new FakeClient()
    const sync = new ServerLibrarySync(db, mkdtempSync(join(base2, 'dati-')), () => c as unknown as PonteClient, () => {})
    expect(sync.selection().items.map((i) => i.id)).toEqual(['regia/Musica/x.mp3'])
    await sync.syncNow(true)
    await sync.syncNow(true)
    expect(c.uploads).toEqual(['regia/Musica/x.mp3'])
  })

  it('un file rifiutato dal server o troppo grande non blocca gli altri; un invio interrotto conta nel limite', async () => {
    const db = new RadioDb(':memory:')
    const m = join(base2, 'M2', 'Musica')
    db.addFolder(m, 'music')
    add(db, join(m, 'a.mp3'), 'A', 1000)
    add(db, join(m, 'b.mp3'), 'B', 1000)
    add(db, join(m, 'c.mp3'), 'C', 1000)
    const { PonteError } = await import('../src/core/ponteClient')
    const c = new FakeClient()
    const upload = c.uploadLibraryFile.bind(c)
    let calls = 0
    c.uploadLibraryFile = async (meta, body) => {
      calls++
      if (meta.id.endsWith('a.mp3')) throw new PonteError('percorso non valido', 400)
      if (meta.id.endsWith('b.mp3') && calls < 3) {
        // il 4G cade a metà: qualche byte è già partito
        const r = (body as ReadableStream<Uint8Array>).getReader()
        await r.read()
        throw new PonteError('ponte non raggiungibile')
      }
      return upload(meta, body)
    }
    const data = mkdtempSync(join(base2, 'dati-'))
    const sync = new ServerLibrarySync(db, data, () => c as unknown as PonteClient, () => {})
    await expect(sync.syncNow(true)).rejects.toThrow(/non raggiungibile/)
    expect(JSON.parse(readFileSync(join(data, 'libreria-server.json'), 'utf8')).bytes).toBeGreaterThan(0)
    const res = await sync.syncNow(true)
    expect(c.uploads).toEqual(['regia/Musica/b.mp3', 'regia/Musica/c.mp3'])
    expect(res).toMatch(/1 rifiutati dal server \(percorso non valido\)/)
  })

  it('i file oltre il limite del server si saltano', async () => {
    const db = new RadioDb(':memory:')
    const m = join(base2, 'M3', 'Musica')
    db.addFolder(m, 'music')
    add(db, join(m, 'a.mp3'), 'A', 10)
    add(db, join(m, 'b.mp3'), 'B', 10)
    // dimensione dichiarata enorme (non serve un file vero da 300 MB)
    const big = db.searchTracks({ text: 'A' }).tracks[0]
    const orig = db.musicForServer.bind(db)
    db.musicForServer = () => orig().map((r) => (r.track.id === big.id ? { ...r, size: 400 * 1024 * 1024 } : r))
    db.saveSettings({ ponte: { ...db.getSettings().ponte, libraryDailyMb: 100_000 } })
    const c = new FakeClient()
    const sync = new ServerLibrarySync(db, mkdtempSync(join(base2, 'dati-')), () => c as unknown as PonteClient, () => {})
    const res = await sync.syncNow(true)
    expect(c.uploads).toEqual(['regia/Musica/b.mp3'])
    expect(res).toMatch(/1 saltati perché troppo grandi/)
  })

  it('non toglie dal server i brani che mancano solo per ora in regia; toglie quelli esclusi', async () => {
    const db = new RadioDb(':memory:')
    const m = join(base2, 'M5', 'Musica')
    const nas = join(base2, 'M5', 'NAS', 'Archivio')
    db.addFolder(m, 'music')
    const gone = add(db, join(m, 'sparito.mp3'), 'File sparito', 10)
    const excluded = add(db, join(m, 'escluso.mp3'), 'Escluso a mano', 10)
    add(db, join(m, 'resta.mp3'), 'Resta', 10)
    const live = add(db, join(m, 'live.mp3'), 'Sally (Live)', 10)
    db.markMissing(gone) // file non trovato dalla scansione: tornerà
    db.markMissing(live) // mancante, ma la regola lo esclude comunque
    db.setServerChoice(excluded, false)
    db.addFolder(nas, 'music') // cartella che adesso non si legge (NAS spento)
    const c = new FakeClient()
    for (const id of ['sparito', 'escluso', 'resta', 'live']) c.files.set(`regia/Musica/${id}.mp3`, 10)
    c.files.set('regia/Archivio/Rock/a.mp3', 5)
    c.files.set('regia/Vecchia/b.mp3', 5) // cartella tolta dalla libreria
    const sync = new ServerLibrarySync(db, mkdtempSync(join(base2, 'dati-')), () => c as unknown as PonteClient, () => {})
    await sync.syncNow(true)
    expect([...c.files.keys()].sort()).toEqual([
      'regia/Archivio/Rock/a.mp3',
      'regia/Musica/resta.mp3',
      'regia/Musica/sparito.mp3'
    ])
  })

  it('un brano caricato dal pannello resta sul server anche se la regola lo escluderebbe', async () => {
    const db = new RadioDb(':memory:')
    const m = join(base2, 'M4', 'Musica')
    mkdirSync(m, { recursive: true })
    db.addFolder(m, 'music')
    const audio = execFileSync(ffmpegStatic as unknown as string, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-b:a', '96k', '-f', 'mp3', 'pipe:1'])
    const c = new FakeClient()
    c.uploaded.push({ id: 'caricati/telefono.mp3', size: audio.length, title: 'Registrazione', artist: 'Ospite', duration: 1, data: new Uint8Array(audio) })
    const sync = new ServerLibrarySync(db, mkdtempSync(join(base2, 'dati-')), () => c as unknown as PonteClient, () => {})
    await sync.syncNow(true)
    const t = db.findByPath(join(m, 'Ospite', 'Registrazione.mp3'))!
    expect(t.bitrate).toBeLessThan(192)
    expect(sync.selection().items.map((i) => i.id)).toContain('regia/Musica/Ospite/Registrazione.mp3')
  })
})
