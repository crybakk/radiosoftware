import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeRemote, RemoteLink, remoteUrl, toRemoteState, type RemoteLinkStatus } from '../src/core/remote'
import { PlayoutEngine } from '../src/core/playout'
import { FakeBackend, FakeClock, makeTrack } from './helpers'

const TOKEN = 'token-di-prova-abbastanza-lungo'
const ADMIN = 'password-admin'
const port = 41000 + Math.floor(Math.random() * 5000)
let server: ChildProcess

beforeAll(async () => {
  server = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'ponte/controllo/src/server.ts'], {
    env: {
      ...process.env,
      CONTROLLO_TOKEN: TOKEN,
      CONTROLLO_PORTA: String(port),
      CONTROLLO_PORTA_INTERNA: String(port + 1),
      CARTELLA_DATI: mkdtempSync(join(tmpdir(), 'ponte-')),
      LIQUIDSOAP_INTERNO: 'http://127.0.0.1:1',
      PANNELLO_ADMIN_PASSWORD: ADMIN
    },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  await new Promise<void>((resolve) => server.stdout!.on('data', (d: Buffer) => String(d).includes('Controllo in ascolto') && resolve()))
})
afterAll(() => server.kill())

function host() {
  return {
    fillQueue: async () => [],
    logStart: async () => 1,
    logEnd: async () => {},
    expandEvent: async () => []
  }
}

describe('stato e comandi della regia', () => {
  it('riassume lo stato senza percorsi di file', async () => {
    const clock = new FakeClock()
    const engine = new PlayoutEngine(new FakeBackend(clock), host(), { crossfadeSeconds: 2, targetLoudness: -16, autoQueueLength: 3 }, () => clock.now())
    const a = makeTrack({ id: 1, title: 'Emozioni', artist: 'Lucio Battisti', duration: 200 })
    engine.enqueue(a)
    const s = toRemoteState(engine.snapshot(), [a, null], 'collegato')
    expect(JSON.stringify(s)).not.toContain(a.path)
    expect(s.queue[0]).toMatchObject({ title: 'Emozioni', origin: 'manual' })
    expect(s.carts).toEqual([
      { n: 1, name: 'Emozioni', playing: false },
      { n: 2, name: null, playing: false }
    ])
  })

  it('esegue i comandi sul motore', async () => {
    const clock = new FakeClock()
    const engine = new PlayoutEngine(new FakeBackend(clock), host(), { crossfadeSeconds: 2, targetLoudness: -16, autoQueueLength: 3 }, () => clock.now())
    const a = makeTrack({ id: 1, title: 'A' })
    const b = makeTrack({ id: 2, title: 'B' })
    const deps = { getTrack: async (id: number) => (id === 1 ? a : id === 2 ? b : null), search: async () => [a], carts: () => [] }
    await executeRemote(engine, { type: 'enqueue', trackId: 1, where: 'end' }, deps)
    await executeRemote(engine, { type: 'enqueue', trackId: 2, where: 'next' }, deps)
    expect(engine.snapshot().queue.map((q) => q.track.title)).toEqual(['B', 'A'])
    await executeRemote(engine, { type: 'mode', mode: 'auto' }, deps)
    expect(engine.getMode()).toBe('auto')
    await expect(executeRemote(engine, { type: 'enqueue', trackId: 9, where: 'end' }, deps)).rejects.toThrow('brano non trovato')
    await expect(executeRemote(engine, { type: 'cart', n: 3 }, deps)).rejects.toThrow('vuoto')
    const found = (await executeRemote(engine, { type: 'search', q: 'a' }, deps)) as { title: string; path?: string }[]
    expect(found[0].title).toBe('A')
    expect(found[0].path).toBeUndefined()
  })

  it('indirizzo del canale', () => {
    expect(remoteUrl('radio.esempio.it', 9080, false)).toBe('ws://radio.esempio.it:9080/ws/regia')
    expect(remoteUrl('radio.esempio.it', 9080, true)).toBe('wss://radio.esempio.it:9080/ws/regia')
    expect(remoteUrl('https://radio.esempio.it:8443/', 9080, false)).toBe('wss://radio.esempio.it:8443/ws/regia')
  })
})

describe('regia, ponte e pannello insieme', () => {
  it('il pannello comanda la regia attraverso il ponte', async () => {
    const statuses: RemoteLinkStatus[] = []
    const received: string[] = []
    const link = new RemoteLink(
      async (cmd, by) => {
        received.push(`${by}:${cmd.type}`)
        if (cmd.type === 'search') return [{ id: 1, title: 'Emozioni', artist: 'Lucio Battisti', kind: 'music', duration: 200 }]
        return null
      },
      (s) => statuses.push(s)
    )
    link.start(remoteUrl('127.0.0.1', port, false), TOKEN)
    await until(() => link.getStatus().state === 'collegato')

    // accesso al pannello
    const base = `http://127.0.0.1:${port}`
    const bad = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'admin', password: 'no' }) })
    expect(bad.status).toBe(401)
    const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'admin', password: ADMIN }) })
    expect(r.status).toBe(200)
    const cookie = r.headers.get('set-cookie')!.split(';')[0]
    expect((await (await fetch(`${base}/`)).text())).toContain('Regia remota')

    // utente conduttore creato dall'amministratore
    const u = await fetch(`${base}/api/utenti`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ name: 'anna', role: 'conduttore', password: 'password-anna' }) })
    expect(u.status).toBe(200)

    // canale del pannello (il WebSocket di Node accetta intestazioni come estensione)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pannello`, { headers: { cookie } } as never)
    const msgs: any[] = []
    ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)))
    await until(() => msgs.some((m) => m.t === 'hello'))
    expect(msgs.find((m) => m.t === 'hello')).toMatchObject({ studio: true, user: { name: 'admin' } })

    link.sendState({ mode: 'auto', onAir: null, queue: [], carts: [], uplink: '', lastError: null, at: new Date().toISOString() })
    await until(() => msgs.some((m) => m.t === 'state'))

    ws.send(JSON.stringify({ t: 'cmd', id: 'x1', cmd: { type: 'next' } }))
    ws.send(JSON.stringify({ t: 'cmd', id: 'x2', cmd: { type: 'search', q: 'battisti' } }))
    await until(() => msgs.filter((m) => m.t === 'reply').length === 2)
    expect(received).toEqual(['admin:next', 'admin:search'])
    expect(msgs.find((m) => m.id === 'x2').data[0].title).toBe('Emozioni')

    // la regia cade: il pannello lo sa e la regia si ricollega da sola
    link.stop()
    await until(() => msgs.some((m) => m.t === 'studio' && m.connected === false))
    ws.close()

    // pannello senza sessione: rifiutato
    const anon = new WebSocket(`ws://127.0.0.1:${port}/ws/pannello`)
    const opened = await new Promise((res) => {
      anon.onopen = () => res(true)
      anon.onerror = () => res(false)
      anon.onclose = () => res(false)
    })
    expect(opened).toBe(false)
  }, 60000)

  it('token sbagliato: la regia lo segnala', async () => {
    const link = new RemoteLink(async () => null, () => {})
    link.start(remoteUrl('127.0.0.1', port, false), 'sbagliato-sbagliato')
    await until(() => link.getStatus().state === 'errore')
    expect(link.getStatus().message).toContain('token del ponte errato')
    link.stop()
  })
})

/** WebSocket finto: il test fa la parte del ponte. */
class FakeWs {
  static all: FakeWs[] = []
  readyState = 0
  sent: any[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeWs.all.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}

describe('collegamento della regia (ponte finto)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('dopo il primo ping, se il ponte tace la regia chiude e si ricollega', async () => {
    FakeWs.all = []
    const link = new RemoteLink(async () => null, () => {}, FakeWs as never, { silenceMs: 150 })
    link.start('ws://ponte/ws/regia', TOKEN)
    await until(() => FakeWs.all[0]?.sent.length === 1)
    const first = FakeWs.all[0]
    first.receive({ t: 'auth-ok' })
    first.receive({ t: 'ping' })
    expect(link.getStatus().state).toBe('collegato')
    // i messaggi tengono vivo il collegamento
    for (let i = 0; i < 4; i++) {
      await sleep(80)
      first.receive({ t: 'ping' })
    }
    expect(first.closed).toBe(false)
    // poi silenzio (4G "appeso"): chiuso e nuovo tentativo
    await until(() => first.closed, 2000)
    expect(link.getStatus().state).toBe('errore')
    expect(link.getStatus().message).toContain('segni di vita')
    await until(() => FakeWs.all.length === 2, 5000)
    link.stop()
  })

  it('ponte vecchio senza ping: nessuna chiusura per silenzio', async () => {
    FakeWs.all = []
    const link = new RemoteLink(async () => null, () => {}, FakeWs as never, { silenceMs: 50 })
    link.start('ws://ponte/ws/regia', TOKEN)
    await until(() => FakeWs.all[0]?.sent.length === 1)
    FakeWs.all[0].receive({ t: 'auth-ok' })
    await sleep(300)
    expect(FakeWs.all[0].closed).toBe(false)
    expect(link.getStatus().state).toBe('collegato')
    link.stop()
  })

  it('messaggi non validi (null, numeri) vengono ignorati', async () => {
    FakeWs.all = []
    const link = new RemoteLink(async () => null, () => {}, FakeWs as never)
    link.start('ws://ponte/ws/regia', TOKEN)
    await until(() => FakeWs.all[0]?.sent.length === 1)
    const ws = FakeWs.all[0]
    expect(() => {
      ws.onmessage?.({ data: 'null' })
      ws.onmessage?.({ data: '42' })
      ws.onmessage?.({ data: '"x"' })
    }).not.toThrow()
    ws.receive({ t: 'auth-ok' })
    expect(link.getStatus().state).toBe('collegato')
    link.stop()
  })

  it('i comandi vengono eseguiti nell\'ordine di arrivo, la ricerca no', async () => {
    FakeWs.all = []
    const log: string[] = []
    const link = new RemoteLink(
      async (cmd) => {
        log.push(`inizio ${cmd.type}`)
        // il primo comando è lento (es. caricamento del brano)
        await sleep(cmd.type === 'enqueue' ? 100 : 5)
        log.push(`fine ${cmd.type}`)
        return null
      },
      () => {},
      FakeWs as never
    )
    link.start('ws://ponte/ws/regia', TOKEN)
    await until(() => FakeWs.all[0]?.sent.length === 1)
    const ws = FakeWs.all[0]
    ws.receive({ t: 'auth-ok' })
    ws.receive({ t: 'cmd', id: '1', by: 'anna', cmd: { type: 'enqueue', trackId: 1, where: 'next' } })
    ws.receive({ t: 'cmd', id: '2', by: 'anna', cmd: { type: 'next' } })
    ws.receive({ t: 'cmd', id: '3', by: 'anna', cmd: { type: 'search', q: 'x' } })
    await until(() => ws.sent.filter((m) => m.t === 'reply').length === 3)
    expect(log.indexOf('inizio next')).toBeGreaterThan(log.indexOf('fine enqueue'))
    expect(log.indexOf('inizio search')).toBeLessThan(log.indexOf('fine enqueue'))
    expect(ws.sent.filter((m) => m.t === 'reply').map((m) => m.id)).toEqual(['3', '1', '2'])
    link.stop()
  })

  it('un comando fallito non blocca i successivi', async () => {
    FakeWs.all = []
    const link = new RemoteLink(
      async (cmd) => {
        if (cmd.type === 'cart') throw new Error('tasto jingle vuoto')
        return null
      },
      () => {},
      FakeWs as never
    )
    link.start('ws://ponte/ws/regia', TOKEN)
    await until(() => FakeWs.all[0]?.sent.length === 1)
    const ws = FakeWs.all[0]
    ws.receive({ t: 'auth-ok' })
    ws.receive({ t: 'cmd', id: '1', by: 'a', cmd: { type: 'cart', n: 5 } })
    ws.receive({ t: 'cmd', id: '2', by: 'a', cmd: { type: 'play' } })
    await until(() => ws.sent.filter((m) => m.t === 'reply').length === 2)
    expect(ws.sent.filter((m) => m.t === 'reply')).toEqual([
      { t: 'reply', id: '1', ok: false, error: 'tasto jingle vuoto' },
      { t: 'reply', id: '2', ok: true }
    ])
    link.stop()
  })
})

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('tempo scaduto')
    await new Promise((r) => setTimeout(r, 20))
  }
}
