import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { activeSlot, Programs, slug } from './programmi.ts'
import { handleProgramApi, sendFile, type ProgramApiDeps } from './programmiApi.ts'
import { isPublishing, publishEpisode, Recorder, type Proc } from './puntate.ts'
import type { PublicUser } from './users.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'programmi-'))
const at = (s: string): Date => new Date(s)

describe('fasce orarie', () => {
  const slots = [{ days: [1, 3], start: '21:00', end: '23:00' }, { days: [5], start: '23:30', end: '01:00' }]
  it('riconosce la fascia del giorno giusto con il margine', () => {
    // 16/11/2026 è lunedì
    expect(activeSlot(slots, at('2026-11-16T21:30:00'))).not.toBeNull()
    expect(activeSlot(slots, at('2026-11-17T21:30:00'))).toBeNull()
    expect(activeSlot(slots, at('2026-11-16T20:59:00'))).toBeNull()
    const s = activeSlot(slots, at('2026-11-16T20:59:00'), 2)!
    expect(new Date(s.from).toTimeString().slice(0, 5)).toBe('20:58')
    expect(new Date(s.to).toTimeString().slice(0, 5)).toBe('23:02')
    expect(activeSlot(slots, at('2026-11-16T23:01:00'), 2)).not.toBeNull()
    expect(activeSlot(slots, at('2026-11-16T23:03:00'), 2)).toBeNull()
  })
  it('gestisce le fasce che passano la mezzanotte', () => {
    // venerdì 20/11 23:30 → sabato 21/11 01:00
    expect(activeSlot(slots, at('2026-11-20T23:45:00'))).not.toBeNull()
    expect(activeSlot(slots, at('2026-11-21T00:30:00'))).not.toBeNull()
    expect(activeSlot(slots, at('2026-11-21T01:00:00'))).toBeNull()
    expect(activeSlot(slots, at('2026-11-20T00:30:00'))).toBeNull()
  })
  it('il margine vale anche prima di una fascia che inizia a mezzanotte', () => {
    // lunedì 16/11 00:00-01:00: con 2 minuti di margine si parte domenica alle 23:58
    const mezzanotte = [{ days: [1], start: '00:00', end: '01:00' }]
    const s = activeSlot(mezzanotte, at('2026-11-15T23:59:00'), 2)
    expect(s).not.toBeNull()
    expect(new Date(s!.from).toTimeString().slice(0, 5)).toBe('23:58')
    expect(activeSlot(mezzanotte, at('2026-11-15T23:57:00'), 2)).toBeNull()
  })
  it('con più fasce in corso prende quella che finisce più tardi', () => {
    const s = activeSlot([{ days: [1], start: '21:00', end: '22:00' }, { days: [1], start: '22:00', end: '23:00' }], at('2026-11-16T21:59:00'), 2)!
    expect(new Date(s.to).toTimeString().slice(0, 5)).toBe('23:02')
  })
  it('nei giorni del cambio dell\'ora gli orari restano quelli dell\'orologio', () => {
    const tz = process.env.TZ
    process.env.TZ = 'Europe/Rome'
    try {
      // domenica 29/03/2026 (ora legale) e domenica 25/10/2026 (ora solare)
      for (const day of ['2026-03-29', '2026-10-25']) {
        const sl = [{ days: [0], start: '21:00', end: '22:00' }]
        const s = activeSlot(sl, new Date(`${day}T21:30:00`))
        expect(s).not.toBeNull()
        expect(new Date(s!.from).toTimeString().slice(0, 5)).toBe('21:00')
        expect(new Date(s!.to).toTimeString().slice(0, 5)).toBe('22:00')
        expect(activeSlot(sl, new Date(`${day}T22:30:00`))).toBeNull()
      }
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })
  it('una fascia senza giorni validi non si salva', () => {
    const p = new Programs(tmp())
    expect(() => p.saveProgram({ title: 'X', slots: [{ days: [9, -1], start: '10:00', end: '11:00' }] })).toThrow(/giorno/)
  })
})

describe('archivio dei programmi', () => {
  it('crea, modifica e controlla i programmi', () => {
    const p = new Programs(tmp())
    expect(slug('Buongiorno Città!')).toBe('buongiorno_citta')
    expect(() => p.saveProgram({ title: '' })).toThrow(/nome/)
    expect(() => p.saveProgram({ title: 'X', slots: [{ days: [1], start: '25:00', end: '10:00' }] })).toThrow(/orari/)
    const a = p.saveProgram({ title: 'Buongiorno Città', author: 'Anna', slots: [{ days: [1, 1, 9], start: '07:00', end: '09:00' }] })
    const b = p.saveProgram({ title: 'Buongiorno Città' })
    expect(a.id).toBe('buongiorno_citta')
    expect(b.id).toBe('buongiorno_citta_2')
    expect(a.slots[0].days).toEqual([1])
    p.saveProgram({ id: a.id, title: 'Buongiorno!', record: false })
    expect(p.get(a.id)).toMatchObject({ title: 'Buongiorno!', record: false, author: '' })
    expect(() => p.setArt(a.id, new Uint8Array([1, 2, 3, 4]))).toThrow(/PNG o JPG/)
    p.setArt(a.id, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))
    expect(p.get(a.id)!.art).toBe('png')
    expect(() => p.setSettings({ station: 'La Radio' })).toThrow(/stazione/)
    expect(p.setSettings({ station: 'la_radio', marginMinutes: 99 })).toEqual({ station: 'la_radio', marginMinutes: 15 })
    // si rilegge dal disco
    const again = new Programs(p.dir)
    expect(again.list().map((x) => x.id)).toEqual([a.id, b.id])
    expect(again.settings().station).toBe('la_radio')
    again.removeProgram(a.id)
    expect(again.list().map((x) => x.id)).toEqual([b.id])
  })

  it('una registrazione interrotta dallo spegnimento diventa una bozza', () => {
    const p = new Programs(tmp())
    const prog = p.saveProgram({ title: 'Sera' })
    const e = p.startRecording(prog.id, Date.now())
    writeFileSync(p.rawFile(e.id), Buffer.alloc(20_000))
    const again = new Programs(p.dir)
    expect(again.episode(e.id)).toMatchObject({ status: 'bozza', size: 20_000 })
  })
})

class FakeProc extends EventEmitter implements Proc {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): void {
    this.killed = true
    setImmediate(() => this.emit('exit', null))
  }
}

describe('registrazione automatica', () => {
  let clock = at('2026-11-16T20:57:00').getTime()
  const procs: FakeProc[] = []
  afterEach(() => (procs.length = 0))

  it('registra la fascia, riparte se ffmpeg si ferma, poi crea la bozza', async () => {
    const p = new Programs(tmp())
    const prog = p.saveProgram({ title: 'Sera', slots: [{ days: [1], start: '21:00', end: '22:00' }] })
    p.saveProgram({ title: 'Senza registrazione', record: false, slots: [{ days: [1], start: '21:00', end: '22:00' }] })
    const drafts: string[] = []
    const rec = new Recorder({
      programs: p,
      url: 'http://liquidsoap/programma',
      now: () => clock,
      spawn: () => {
        const x = new FakeProc()
        procs.push(x)
        return x
      },
      seconds: async () => 3660,
      log: () => {},
      onDraft: (e) => drafts.push(e.id)
    })
    rec.tick()
    expect(procs).toHaveLength(0)
    clock = at('2026-11-16T20:58:30').getTime()
    rec.tick()
    expect(procs).toHaveLength(1)
    expect(rec.recording()).toHaveLength(1)
    const id = rec.recording()[0].episodeId
    procs[0].stdout.write(Buffer.alloc(8000, 1))
    await new Promise((r) => setImmediate(r))
    // ffmpeg si ferma da solo: riparte dopo 5 secondi
    procs[0].emit('exit', 1)
    await new Promise((r) => setTimeout(r, 5200))
    expect(procs).toHaveLength(2)
    procs[1].stdout.write(Buffer.alloc(8000, 2))
    await new Promise((r) => setImmediate(r))
    clock = at('2026-11-16T22:03:00').getTime()
    rec.tick()
    await new Promise((r) => setTimeout(r, 50))
    expect(procs[1].killed).toBe(true)
    expect(rec.recording()).toHaveLength(0)
    expect(drafts).toEqual([id])
    expect(p.episode(id)).toMatchObject({ status: 'bozza', length: 3660, size: 16000, programId: prog.id })
    // le due parti sono nello stesso file
    expect(readFileSync(p.rawFile(id))[8000]).toBe(2)
  }, 10_000)

  it('fasce attaccate: una sola registrazione', async () => {
    clock = at('2026-11-16T20:59:00').getTime()
    const p = new Programs(tmp())
    p.saveProgram({ title: 'Sera', slots: [{ days: [1], start: '21:00', end: '22:00' }, { days: [1], start: '22:00', end: '23:00' }] })
    const spawned: FakeProc[] = []
    const rec = new Recorder({ programs: p, url: 'x', now: () => clock, spawn: () => (spawned.push(new FakeProc()), spawned.at(-1)!), seconds: async () => 0, log: () => {} })
    rec.tick()
    clock = at('2026-11-16T22:01:00').getTime()
    rec.tick()
    clock = at('2026-11-16T22:05:00').getTime()
    rec.tick()
    expect(spawned).toHaveLength(1)
    expect(rec.recording()).toHaveLength(1)
    expect(new Date(rec.recording()[0].to).toTimeString().slice(0, 5)).toBe('23:02')
    await rec.stop()
  })

  it('disco pieno, ffmpeg mancante o ostinato: il server non cade', async () => {
    clock = at('2026-11-16T21:10:00').getTime()
    const dir = tmp()
    // il file della registrazione non si può scrivere (qui è una cartella)
    class Broken extends Programs {
      override rawFile(id: string): string {
        const f = join(this.dir, 'registrazioni', id)
        mkdirSync(f, { recursive: true })
        return f
      }
    }
    const p = new Broken(dir)
    p.saveProgram({ title: 'Sera', slots: [{ days: [1], start: '21:00', end: '22:00' }] })
    const logs: string[] = []
    const rec = new Recorder({ programs: p, url: 'x', now: () => clock, spawn: () => new FakeProc(), seconds: async () => { throw new Error('illeggibile') }, log: (s) => logs.push(s) })
    rec.tick()
    await new Promise((r) => setTimeout(r, 50))
    expect(logs.some((l) => l.includes('non si scrive'))).toBe(true)
    await rec.stop()
    expect(rec.recording()).toHaveLength(0)

    // ffmpeg che non esiste
    const q = new Programs(tmp())
    q.saveProgram({ title: 'Sera', slots: [{ days: [1], start: '21:00', end: '22:00' }] })
    const rec2 = new Recorder({ programs: q, url: 'x', now: () => clock, ffmpeg: '/non/esiste/ffmpeg', seconds: async () => 0, log: () => {} })
    rec2.tick()
    await new Promise((r) => setTimeout(r, 100))
    await rec2.stop()

    // ffmpeg che non si ferma: dopo 3 secondi si chiude per forza, e quello che scrive dopo non va nel file
    const z = new Programs(tmp())
    z.saveProgram({ title: 'Sera', slots: [{ days: [1], start: '21:00', end: '22:00' }] })
    const stubborn = new FakeProc()
    const signals: (string | undefined)[] = []
    stubborn.kill = (sig?: string) => void signals.push(sig)
    const rec3 = new Recorder({ programs: z, url: 'x', now: () => clock, spawn: () => stubborn, seconds: async () => 0, log: () => {} })
    rec3.tick()
    await rec3.stop()
    expect(signals).toEqual([undefined, 'SIGKILL'])
    stubborn.stdout.write(Buffer.alloc(100))
    await new Promise((r) => setTimeout(r, 50))

    // l'archivio non si salva: tick non lancia
    const w = new Programs(tmp())
    w.saveProgram({ title: 'Sera', slots: [{ days: [1], start: '21:00', end: '22:00' }] })
    w.startRecording = () => {
      throw new Error('ENOSPC')
    }
    const rec4 = new Recorder({ programs: w, url: 'x', now: () => clock, spawn: () => new FakeProc(), log: () => {} })
    expect(() => rec4.tick()).not.toThrow()
  }, 10_000)

  it('scarta le registrazioni senza audio', async () => {
    clock = at('2026-11-16T21:10:00').getTime()
    const p = new Programs(tmp())
    p.saveProgram({ title: 'Sera', slots: [{ days: [1], start: '21:00', end: '22:00' }] })
    const rec = new Recorder({ programs: p, url: 'x', now: () => clock, spawn: () => new FakeProc(), seconds: async () => 0, log: () => {} })
    rec.tick()
    await rec.stop()
    expect(p.episodes()).toHaveLength(0)
  })
})

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

function makeMp3(file: string, seconds: number): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '128k', file])
}

describe('pubblicazione, casi difficili', () => {
  it('ffmpeg mancante: errore e non attesa infinita', async () => {
    const p = new Programs(tmp())
    const e = p.startRecording(p.saveProgram({ title: 'Sera' }).id, Date.now())
    writeFileSync(p.rawFile(e.id), Buffer.alloc(20_000))
    p.endRecording(e.id, Date.now(), 60)
    await expect(publishEpisode(p, e.id, { from: 0, to: 30, title: '', description: '' }, { ffmpeg: '/non/esiste/ffmpeg' })).rejects.toThrow(/taglio/)
    expect(isPublishing(e.id)).toBe(false)
  })

  it('una bozza si pubblica una volta sola; eliminata durante il taglio non lascia file', async () => {
    const p = new Programs(tmp())
    const e = p.startRecording(p.saveProgram({ title: 'Sera' }).id, Date.now())
    writeFileSync(p.rawFile(e.id), Buffer.alloc(20_000))
    p.endRecording(e.id, Date.now(), 60)
    const proc = new FakeProc()
    const spawn = () => proc
    const first = publishEpisode(p, e.id, { from: 0, to: 30, title: '', description: '' }, { spawn, seconds: async () => 30 })
    expect(isPublishing(e.id)).toBe(true)
    await expect(publishEpisode(p, e.id, { from: 0, to: 30, title: '', description: '' }, { spawn })).rejects.toThrow(/già/)
    p.removeEpisode(e.id)
    writeFileSync(`${p.episodeFile(e.id)}.tmp`, 'x')
    proc.emit('exit', 0)
    await expect(first).rejects.toThrow(/non trovata/)
    expect(existsSync(p.episodeFile(e.id))).toBe(false)
    expect(isPublishing(e.id)).toBe(false)
  })
})

describe.skipIf(!hasFfmpeg)('pubblicazione', () => {
  it('taglia la bozza tra inizio e fine e la pubblica', async () => {
    const p = new Programs(tmp())
    const prog = p.saveProgram({ title: 'Sera' })
    const e = p.startRecording(prog.id, Date.now())
    makeMp3(p.rawFile(e.id), 60)
    p.endRecording(e.id, Date.now(), 60)
    await expect(publishEpisode(p, e.id, { from: 10, to: 15, title: '', description: '' })).rejects.toThrow(/10 secondi/)
    const out = await publishEpisode(p, e.id, { from: 10, to: 40, title: 'Puntata 1', description: 'Ospite: Luca' })
    expect(out).toMatchObject({ status: 'pubblicata', title: 'Puntata 1', description: 'Ospite: Luca' })
    expect(Math.abs(out.length - 30)).toBeLessThanOrEqual(1)
    expect(existsSync(p.rawFile(e.id))).toBe(false)
    expect(statSync(p.episodeFile(e.id)).size).toBeGreaterThan(400_000)
    expect(p.publicEpisodes(prog.id)).toHaveLength(1)
    p.setVisible(e.id, false)
    expect(p.publicEpisodes(prog.id)).toHaveLength(0)
    p.setVisible(e.id, true)
    expect(p.publicEpisodes(prog.id)).toHaveLength(1)
  })
})

describe('indirizzi HTTP', () => {
  let server: Server | null = null
  afterEach(() => server?.close())

  async function start(user: PublicUser | null, token = false) {
    const p = new Programs(tmp())
    p.setSettings({ station: 'radio_test' })
    const prog = p.saveProgram({ title: 'Sera', author: 'Anna', description: 'Il programma della sera' })
    p.saveProgram({ title: 'Nascosto', published: false })
    p.setArt(prog.id, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]))
    const e = p.startRecording(prog.id, Date.now())
    writeFileSync(p.rawFile(e.id), Buffer.alloc(20_000))
    p.endRecording(e.id, Date.now(), 60)
    const deps: ProgramApiDeps = {
      programs: p,
      recorder: null,
      stationName: 'Radio Test',
      listenUrl: 'https://radio.test/radio.mp3',
      nowPlaying: () => ({ artist: 'A', title: 'T' }),
      user: () => user,
      sameOrigin: () => true,
      authorized: () => token,
      base: () => 'https://radio.test',
      publish: async (P, id, m) => {
        writeFileSync(P.episodeFile(id), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)))
        return P.published(id, { title: m.title, description: m.description, length: 1800 })
      }
    }
    server = createServer((req, res) => {
      void handleProgramApi(req, res, new URL(req.url ?? '/', 'http://x'), deps).then((done) => {
        if (!done) res.writeHead(404).end()
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    return { p, prog, e, base }
  }

  it('API pubbliche come AzuraCast, solo ascolto', async () => {
    const admin: PublicUser = { name: 'admin', role: 'amministratore' } as PublicUser
    const { prog, e, base } = await start(admin)
    const st = `${base}/api/station/radio_test/public`
    let list = (await (await fetch(`${st}/podcasts`)).json()) as Record<string, unknown>[]
    expect(list.map((x) => x.id)).toEqual([prog.id])
    expect(list[0]).toMatchObject({ title: 'Sera', author: 'Anna', episodes: 0, is_published: true, has_custom_art: true })
    expect((await fetch(`${base}/api/station/altra/public/podcasts`)).status).toBe(404)
    expect((await fetch(`${base}/api/station/1/public/podcasts`)).status).toBe(200)
    expect((await fetch(`${st}/podcast/nascosto`)).status).toBe(404)
    // bozza: non si vede
    expect((await fetch(`${st}/podcast/${prog.id}/episode/${e.id}`)).status).toBe(404)

    const r = await fetch(`${base}/api/puntate`, {
      method: 'POST',
      body: JSON.stringify({ azione: 'pubblica', id: e.id, inizio: 5, fine: 1805, title: 'Puntata 1', description: 'Prima puntata' })
    })
    expect(r.status).toBe(200)
    list = (await (await fetch(`${st}/podcasts`)).json()) as Record<string, unknown>[]
    expect(list[0].episodes).toBe(1)
    const eps = (await (await fetch(`${st}/podcast/${prog.id}/episodes`)).json()) as Record<string, any>[]
    expect(eps).toHaveLength(1)
    expect(eps[0]).toMatchObject({ id: e.id, title: 'Puntata 1', has_media: true, media: { length: 1800, length_text: '30:00' } })
    expect(eps[0].links.download).toBe(`https://radio.test/api/station/radio_test/public/podcast/${prog.id}/episode/${e.id}/download.mp3`)
    const one = (await (await fetch(`${st}/podcast/${prog.id}/episode/${e.id}`)).json()) as Record<string, unknown>
    expect(one.description).toBe('Prima puntata')
    const art = await fetch(`${st}/podcast/${prog.id}/art-123.jpg`)
    expect(art.headers.get('content-type')).toBe('image/jpeg')
    // audio: intero e a pezzi, sempre "inline"
    const dl = await fetch(`${st}/podcast/${prog.id}/episode/${e.id}/download.mp3`)
    expect(dl.headers.get('content-disposition')).toBe('inline')
    expect(dl.headers.get('access-control-allow-origin')).toBe('*')
    expect((await dl.arrayBuffer()).byteLength).toBe(1000)
    const part = await fetch(`${st}/podcast/${prog.id}/episode/${e.id}/download`, { headers: { Range: 'bytes=100-199' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(new Uint8Array(await part.arrayBuffer())[0]).toBe(100)
    expect((await fetch(`${st}/podcasts`, { method: 'POST' })).status).toBe(405)
    const pub = (await (await fetch(`${base}/api/pubblico`)).json()) as Record<string, unknown>
    expect(pub).toEqual({ name: 'Radio Test', station: 'radio_test', listenUrl: 'https://radio.test/radio.mp3', nowPlaying: { artist: 'A', title: 'T' } })
    // ritirata: sparisce
    await fetch(`${base}/api/puntate`, { method: 'POST', body: JSON.stringify({ azione: 'ritira', id: e.id }) })
    expect((await fetch(`${st}/podcast/${prog.id}/episode/${e.id}/download.mp3`)).status).toBe(404)
  })

  it('permessi del pannello e elenco per la regia', async () => {
    const ospite = { name: 'o', role: 'ospite' } as PublicUser
    const { base, e, prog } = await start(ospite, true)
    const state = (await (await fetch(`${base}/api/programmi`)).json()) as Record<string, any>
    expect(state.canAdmin).toBe(false)
    expect(state.episodes[0].status).toBe('bozza')
    expect((await fetch(`${base}/api/puntate/audio?id=${e.id}`)).status).toBe(200)
    expect((await fetch(`${base}/api/programmi`, { method: 'POST', body: JSON.stringify({ azione: 'salva', programma: { title: 'Y' } }) })).status).toBe(403)
    expect((await fetch(`${base}/api/puntate`, { method: 'POST', body: JSON.stringify({ azione: 'elimina', id: e.id }) })).status).toBe(403)
    const regia = (await (await fetch(`${base}/api/programmi/regia`)).json()) as Record<string, unknown>[]
    expect(regia.find((x) => x.id === prog.id)).toMatchObject({ title: 'Sera', episodes: [] })
  })

  it('un file che non si legge non fa cadere il server', async () => {
    const dir = tmp()
    const s = createServer((req, res) => sendFile(req, res, req.url === '/cartella' ? dir : join(dir, 'manca.mp3'), 'audio/mpeg'))
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    expect((await fetch(`${b}/cartella`)).status).toBe(404)
    expect((await fetch(`${b}/manca`)).status).toBe(404)
    s.close()
  })

  it('Range fuori misura', async () => {
    const admin = { name: 'admin', role: 'amministratore' } as PublicUser
    const { prog, e, base } = await start(admin)
    await fetch(`${base}/api/puntate`, { method: 'POST', body: JSON.stringify({ azione: 'pubblica', id: e.id, inizio: 0, fine: 1800, title: 'P', description: '' }) })
    const url = `${base}/api/station/radio_test/public/podcast/${prog.id}/episode/${e.id}/download.mp3`
    expect((await fetch(url, { headers: { Range: 'bytes=5000-' } })).status).toBe(416)
    expect((await fetch(url, { headers: { Range: `bytes=${'9'.repeat(400)}-` } })).status).toBe(416)
    const tail = await fetch(url, { headers: { Range: 'bytes=-10' } })
    expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000')
    const big = await fetch(url, { headers: { Range: 'bytes=10-99999999' } })
    expect(big.headers.get('content-range')).toBe('bytes 10-999/1000')
    expect((await big.arrayBuffer()).byteLength).toBe(990)
  })

  it('senza accesso il pannello risponde 401', async () => {
    const { base } = await start(null)
    expect((await fetch(`${base}/api/programmi`)).status).toBe(401)
    expect((await fetch(`${base}/api/programmi/regia`)).status).toBe(401)
    expect((await fetch(`${base}/altro`)).status).toBe(404)
  })
})
