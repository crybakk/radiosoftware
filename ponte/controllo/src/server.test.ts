// Prove del servizio di controllo completo: si avvia il vero server.ts in un processo separato.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { mkdirSync, writeFileSync } from 'node:fs'
import { coverKey } from './copertine.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123'
const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts')
// chiave di attivazione di prova (coppia di chiavi creata al momento)
const CHIAVE_PROVE = join(dirname(fileURLToPath(import.meta.url)), '..', 'prove', 'chiave-prove.mjs')
let procs: ChildProcess[] = []
// sotto 32768: da lì in su Linux dà le porte ai collegamenti in uscita, che potrebbero occupare quella scelta
let portBase = 21000 + Math.floor(Math.random() * 10000)

async function startServer(
  extra: Record<string, string> = {}
): Promise<{ port: number; internal: number; music: string; proc: ChildProcess; exited: Promise<number | null> }> {
  const port = portBase++
  const internal = portBase++
  const music = mkdtempSync(join(tmpdir(), 'ponte-musica-'))
  const proc = spawn(process.execPath, ['--import', CHIAVE_PROVE, SERVER], {
    env: {
      ...process.env,
      CONTROLLO_TOKEN: TOKEN,
      CARTELLA_DATI: mkdtempSync(join(tmpdir(), 'ponte-')),
      CONTROLLO_PORTA: String(port),
      CONTROLLO_PORTA_INTERNA: String(internal),
      LIQUIDSOAP_INTERNO: 'http://127.0.0.1:1',
      PANNELLO_ADMIN_PASSWORD: 'adminadmin',
      CARTELLA_MUSICA: music,
      ...extra
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  procs.push(proc)
  const exited = new Promise<number | null>((r) => proc.on('exit', (c) => r(c)))
  await new Promise<void>((res, rej) => {
    proc.stdout!.on('data', (d) => String(d).includes('in ascolto sulla porta') && res())
    proc.on('exit', () => rej(new Error('il server si è fermato alla partenza')))
  })
  return { port, internal, music, proc, exited }
}

afterEach(() => {
  for (const p of procs) p.kill('SIGKILL')
  procs = []
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const died = (exited: Promise<number | null>, ms = 1500) =>
  Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

/** Richiesta scritta a mano; restituisce la prima riga della risposta ('' se la connessione si chiude senza risposta). */
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((res) => {
    let out = ''
    const s = connect(port, '127.0.0.1', () => s.write(text))
    s.on('error', () => res(out.split('\r\n')[0]))
    s.on('data', (d) => {
      out += d
      s.destroy()
      res(out.split('\r\n')[0])
    })
    s.on('close', () => res(out.split('\r\n')[0]))
  })
}

async function login(port: number, name: string, password: string): Promise<{ status: number; cookie?: string }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password })
  })
  const sc = r.headers.get('set-cookie') ?? undefined
  return { status: r.status, cookie: sc?.split(';')[0] }
}

function openWs(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, { headers })
    ws.on('open', () => res(ws))
    ws.on('error', rej)
  })
}

const closed = (ws: WebSocket, ms = 1000): Promise<number | null> =>
  new Promise((r) => {
    if (ws.readyState === WebSocket.CLOSED) return r(-1)
    const t = setTimeout(() => r(null), ms)
    ws.on('close', (code) => {
      clearTimeout(t)
      r(code)
    })
  })

async function regia(port: number): Promise<{ ws: WebSocket; cmds: any[] }> {
  const ws = await openWs(`ws://127.0.0.1:${port}/ws/regia`)
  const cmds: any[] = []
  const ok = new Promise((r) =>
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      if (m.t === 'cmd') cmds.push(m)
      if (m.t === 'auth-ok') r(null)
    })
  )
  ws.send(JSON.stringify({ t: 'auth', token: TOKEN }))
  await ok
  return { ws, cmds }
}

const HANDSHAKE =
  'GET /ws/pannello HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'

describe('server senza chiave di attivazione', () => {
  it('mostra solo la pagina di attivazione e rifiuta le API', async () => {
    const { port } = await startServer({ CHIAVE_ATTIVAZIONE: '' })
    const pagina = await fetch(`http://127.0.0.1:${port}/dashboard`)
    expect(pagina.status).toBe(200)
    expect(await pagina.text()).toContain('Attiva il server')
    const api = await fetch(`http://127.0.0.1:${port}/api/nowplaying`)
    expect(api.status).toBe(403)
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'admin', password: 'adminadmin' }) })
    expect(login.status).toBe(403)
    const sbagliata = await fetch(`http://127.0.0.1:${port}/api/attivazione`, { method: 'POST', body: JSON.stringify({ chiave: 'RADIO1.abc.def' }) })
    expect(sbagliata.status).toBe(400)
    expect((await sbagliata.json()).error).toMatch(/non valida/)
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
  })
})

describe('il ponte non cade per richieste anonime malformate', () => {
  it('GET "//" riceve una risposta e il processo resta vivo', async () => {
    const { port, exited } = await startServer()
    expect(await rawRequest(port, 'GET // HTTP/1.1\r\nHost: x\r\n\r\n')).toMatch(/^HTTP\/1\.1 \d+/)
    expect(await died(exited)).toBe(false)
  })

  it('WS /ws/regia: messaggi "null", numeri e liste senza autenticazione', async () => {
    const { port, exited } = await startServer()
    const ws = await openWs(`ws://127.0.0.1:${port}/ws/regia`)
    ws.on('error', () => {})
    for (const m of ['null', '3', '[]', '"x"']) ws.send(m)
    expect(await died(exited)).toBe(false)
  })

  it('WS /ws/pannello: messaggio "null" da un pannello collegato', async () => {
    const { port, exited } = await startServer()
    const admin = await login(port, 'admin', 'adminadmin')
    const ws = await openWs(`ws://127.0.0.1:${port}/ws/pannello`, { Cookie: admin.cookie! })
    for (const m of ['null', '3', '{"t":"cmd","id":"a","cmd":null}']) ws.send(m)
    expect(await died(exited)).toBe(false)
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it('cookie di sessione con codifica non valida (%E0): rifiutato, processo vivo', async () => {
    const { port, exited } = await startServer()
    expect(await rawRequest(port, HANDSHAKE + 'Cookie: sessione=%E0\r\n\r\n')).toBe('HTTP/1.1 401 Unauthorized')
    expect(await died(exited)).toBe(false)
  })

  it('cookie sessione=constructor / __proto__: rifiutato, processo vivo', async () => {
    const { port, exited } = await startServer()
    for (const t of ['constructor', '__proto__', 'toString']) {
      expect(await rawRequest(port, HANDSHAKE + `Cookie: sessione=${t}\r\n\r\n`)).toBe('HTTP/1.1 401 Unauthorized')
      const io = await fetch(`http://127.0.0.1:${port}/api/io`, { headers: { Cookie: `sessione=${t}` } })
      expect(io.status).toBe(401)
    }
    expect(await died(exited)).toBe(false)
  })
})

describe('pagine: player pubblico su / e pannello su /dashboard', () => {
  it('serve le pagine giuste e porta i vecchi indirizzi a quelle nuove', async () => {
    const { port } = await startServer()
    const base = `http://127.0.0.1:${port}`
    const home = await fetch(`${base}/`)
    expect(home.status).toBe(200)
    const homeHtml = await home.text()
    expect(homeHtml).toContain('/player.js')
    expect(homeHtml).not.toContain('login-form')
    // niente numero di ascoltatori sul player pubblico (scelta di cristian)
    expect(homeHtml).not.toContain('listeners')
    expect(await (await fetch(`${base}/player.js`)).text()).not.toContain('listeners')
    for (const p of ['/dashboard', '/dashboard/']) {
      const r = await fetch(base + p)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(html).toContain('login-form')
      expect(html).toContain('/navigazione.js')
    }
    for (const [from, to] of [['/index.html', '/dashboard'], ['/ascolta.html', '/'], ['/player.html', '/']]) {
      const r = await fetch(base + from, { redirect: 'manual' })
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toBe(to)
    }
    // la guida senza accesso rimanda al pannello
    const g = await fetch(`${base}/guida`, { redirect: 'manual' })
    expect(g.headers.get('location')).toBe('/dashboard')
    for (const f of ['/player.js', '/pubblico.css', '/podcast.html', '/pannello.css', '/ospite.html']) expect((await fetch(base + f)).status).toBe(200)
    expect((await fetch(`${base}/dashboard/altro`)).status).toBe(404)
  })
})

describe('copertine dei brani in onda', () => {
  it('copertina già trovata: nel titolo in onda e servita da /api/copertina', async () => {
    const dati = mkdtempSync(join(tmpdir(), 'ponte-'))
    const key = coverKey('Vasco Rossi', 'Albachiara')
    mkdirSync(join(dati, 'copertine'))
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)])
    writeFileSync(join(dati, 'copertine', `${key}.jpg`), jpeg)
    const { port } = await startServer({ CARTELLA_DATI: dati })
    const base = `http://127.0.0.1:${port}`
    await fetch(`${base}/api/metadata`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ artist: 'Vasco Rossi', title: 'Albachiara' }) })
    const np = (await (await fetch(`${base}/api/nowplaying`)).json()) as { now_playing: { song: { art: string } } }[]
    expect(np[0].now_playing.song.art).toBe(`${base}/api/copertina/${key}.jpg`)
    const img = await fetch(`${base}/api/copertina/${key}.jpg`)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await img.arrayBuffer()).equals(jpeg)).toBe(true)
    expect((await fetch(`${base}/api/copertina/${'0'.repeat(32)}.jpg`)).status).toBe(404)
    expect((await fetch(`${base}/api/copertina/abc.jpg`)).status).not.toBe(200)
  })
})

describe('ruoli e sessioni del pannello', () => {
  async function setup() {
    const { port } = await startServer()
    const base = `http://127.0.0.1:${port}`
    const studio = await regia(port)
    const admin = await login(port, 'admin', 'adminadmin')
    const post = (body: unknown) =>
      fetch(`${base}/api/utenti`, {
        method: 'POST',
        headers: { Cookie: admin.cookie!, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    expect((await post({ name: 'mario', role: 'conduttore', password: 'password1' })).status).toBe(200)
    const mario = await login(port, 'mario', 'password1')
    const panel = await openWs(`ws://127.0.0.1:${port}/ws/pannello`, { Cookie: mario.cookie! })
    return { port, base, studio, admin, post, mario, panel }
  }

  it('cambiando ruolo (senza cambiare password) il pannello aperto viene chiuso e non comanda più', async () => {
    const { port, base, studio, post, mario, panel } = await setup()
    const code = closed(panel)
    expect((await post({ name: 'mario', role: 'ospite' })).status).toBe(200)
    expect(await code).toBe(4002) // non 4003: la sessione resta valida e il pannello si ricollega
    const io = await (await fetch(`${base}/api/io`, { headers: { Cookie: mario.cookie! } })).json()
    expect(io.user.role).toBe('ospite')
    // ricollegato, ha il ruolo nuovo
    const again = await openWs(`ws://127.0.0.1:${port}/ws/pannello`, { Cookie: mario.cookie! })
    const replies: any[] = []
    again.on('message', (d) => replies.push(JSON.parse(String(d))))
    again.send(JSON.stringify({ t: 'cmd', id: 'x', cmd: { type: 'stop' } }))
    await wait(200)
    expect(studio.cmds).toEqual([])
    expect(replies.find((m) => m.t === 'reply')).toMatchObject({ id: 'x', ok: false })
  })

  it('eliminando un utente il suo pannello viene chiuso', async () => {
    const { base, admin, panel } = await setup()
    const code = closed(panel)
    const r = await fetch(`${base}/api/utenti/mario`, { method: 'DELETE', headers: { Cookie: admin.cookie! } })
    expect(r.status).toBe(200)
    expect(await code).toBe(4003)
  })

  it("l'uscita chiude i WebSocket aperti con quella sessione (e solo quelli)", async () => {
    const { port, base, mario, panel } = await setup()
    const other = await login(port, 'mario', 'password1')
    const otherWs = await openWs(`ws://127.0.0.1:${port}/ws/pannello`, { Cookie: other.cookie! })
    const code = closed(panel)
    await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: mario.cookie! } })
    expect(await code).toBe(4003)
    await wait(100)
    expect(otherWs.readyState).toBe(WebSocket.OPEN)
  })
})

describe('invito di un nuovo utente con un link', () => {
  it("l'amministratore crea il link, l'invitato sceglie la password ed entra; il link non vale una seconda volta", async () => {
    const { port } = await startServer()
    const base = `http://127.0.0.1:${port}`
    const admin = await login(port, 'admin', 'adminadmin')
    const headers = { 'Content-Type': 'application/json', Cookie: admin.cookie! }
    const r = await fetch(`${base}/api/utenti/inviti`, { method: 'POST', headers, body: JSON.stringify({ name: 'giulia', role: 'conduttore' }) })
    expect(r.status).toBe(200)
    const { invite } = await r.json()
    const list = await (await fetch(`${base}/api/utenti`, { headers })).json()
    expect(list.invites.map((i: any) => i.name)).toEqual(['giulia'])

    // senza accesso non si creano inviti
    expect((await fetch(`${base}/api/utenti/inviti`, { method: 'POST', body: JSON.stringify({ name: 'x1', role: 'amministratore' }) })).status).toBe(401)

    const info = await fetch(`${base}/api/invito?t=${invite.token}`)
    expect(info.status).toBe(200)
    expect(await info.json()).toMatchObject({ name: 'giulia', role: 'conduttore' })
    expect((await fetch(`${base}/invito.html`)).status).toBe(200)

    const ok = await fetch(`${base}/api/invito`, { method: 'POST', body: JSON.stringify({ t: invite.token, password: 'password-giulia' }) })
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]
    const io = await (await fetch(`${base}/api/io`, { headers: { Cookie: cookie } })).json()
    expect(io.user).toEqual({ name: 'giulia', role: 'conduttore' })
    // primo accesso: benvenuto; visto, non torna più
    expect(io.benvenuto).toBe(true)
    expect((await fetch(`${base}/api/io/benvenuto`, { method: 'POST', headers: { Cookie: cookie } })).status).toBe(200)
    expect((await (await fetch(`${base}/api/io`, { headers: { Cookie: cookie } })).json()).benvenuto).toBe(false)
    expect((await fetch(`${base}/api/io/benvenuto`, { method: 'POST' })).status).toBe(401)
    expect((await login(port, 'giulia', 'password-giulia')).status).toBe(200)

    const again = await fetch(`${base}/api/invito`, { method: 'POST', body: JSON.stringify({ t: invite.token, password: 'altra-password' }) })
    expect(again.status).toBe(404)
    expect((await login(port, 'giulia', 'altra-password')).status).toBe(401)
  })

  it('un conduttore non può invitare', async () => {
    const { port } = await startServer()
    const base = `http://127.0.0.1:${port}`
    const admin = await login(port, 'admin', 'adminadmin')
    await fetch(`${base}/api/utenti`, { method: 'POST', headers: { Cookie: admin.cookie! }, body: JSON.stringify({ name: 'mario', role: 'conduttore', password: 'password1' }) })
    const mario = await login(port, 'mario', 'password1')
    const r = await fetch(`${base}/api/utenti/inviti`, { method: 'POST', headers: { Cookie: mario.cookie! }, body: JSON.stringify({ name: 'nuovo', role: 'amministratore' }) })
    expect(r.status).toBe(403)
  })

  it('link inventati: dopo 5 tentativi al minuto si aspetta', async () => {
    const { port } = await startServer()
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await fetch(`http://127.0.0.1:${port}/api/invito?t=inventato${i}`)).status)
    expect(codes).toEqual([404, 404, 404, 404, 404, 429])
  })
})

describe('accesso al pannello', () => {
  it('il limite di 5 tentativi al minuto per indirizzo regge anche a richieste in parallelo', async () => {
    const { port } = await startServer()
    // intestazioni subito e corpo dopo: prima tutte le richieste passavano il controllo
    const body = JSON.stringify({ name: 'admin', password: 'password-sbagliata' })
    const one = () =>
      new Promise<number>((res) => {
        const s = connect(port, '127.0.0.1', () => {
          s.write(`POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`)
          setTimeout(() => s.write(body), 300)
        })
        let out = ''
        s.on('data', (d) => (out += d))
        s.on('end', () => res(Number(out.split(' ')[1])))
        s.on('error', () => res(0))
      })
    const results = await Promise.all(Array.from({ length: 30 }, one))
    expect(results.filter((r) => r === 401).length).toBeLessThanOrEqual(5)
    expect(results.filter((r) => r === 429).length).toBeGreaterThanOrEqual(25)
  }, 20_000)

  it('gli accessi riusciti non consumano tentativi', async () => {
    const { port } = await startServer()
    for (let i = 0; i < 4; i++) expect((await login(port, 'admin', 'sbagliata!')).status).toBe(401)
    for (let i = 0; i < 6; i++) expect((await login(port, 'admin', 'adminadmin')).status).toBe(200)
    expect((await login(port, 'admin', 'sbagliata!')).status).toBe(401)
    expect((await login(port, 'admin', 'adminadmin')).status).toBe(429)
  }, 20_000)
})

describe('backup', () => {
  it('due invii nello stesso istante non si mescolano e il download funziona', async () => {
    const { port } = await startServer()
    const base = `http://127.0.0.1:${port}`
    const auth = { Authorization: `Bearer ${TOKEN}` }
    const a = Buffer.alloc(200_000, 1)
    const b = Buffer.alloc(200_000, 2)
    const put = (data: Buffer) => fetch(`${base}/api/backup`, { method: 'PUT', headers: auth, body: new Uint8Array(data) }).then((r) => r.json())
    const [ra, rb] = await Promise.all([put(a), put(b)])
    expect(ra.ok && rb.ok).toBe(true)
    const list = await (await fetch(`${base}/api/backup`, { headers: auth })).json()
    for (const { name } of list) {
      const got = Buffer.from(await (await fetch(`${base}/api/backup/${name}`, { headers: auth })).arrayBuffer())
      expect(got.length).toBe(200_000)
      // ogni copia è tutta di un invio, non un miscuglio dei due
      expect(got.equals(a) || got.equals(b)).toBe(true)
    }
  })

  it('token sbagliato o di lunghezza diversa: 401', async () => {
    const { port } = await startServer()
    for (const t of ['x', TOKEN.slice(0, -1) + 'X', TOKEN + 'X']) {
      const r = await fetch(`http://127.0.0.1:${port}/api/backup`, { headers: { Authorization: `Bearer ${t}` } })
      expect(r.status).toBe(401)
    }
  })
})

describe('disco quasi pieno', () => {
  it('caricamenti, libreria della regia e backup rifiutati con 507 e il motivo; allarme aperto', async () => {
    const { port, exited } = await startServer({ SPAZIO_MINIMO_MB: '999999999' })
    const base = `http://127.0.0.1:${port}`
    const auth = { Authorization: `Bearer ${TOKEN}` }
    const admin = await login(port, 'admin', 'adminadmin')
    const up = await fetch(`${base}/api/autonoma/carica?nome=prova.mp3`, { method: 'PUT', headers: { Cookie: admin.cookie! }, body: new Uint8Array(1000) })
    expect(up.status).toBe(507)
    expect((await up.json()).error).toMatch(/spazio sul disco/)
    const lib = await fetch(`${base}/api/libreria?id=regia/Rock/a.mp3`, { method: 'PUT', headers: auth, body: new Uint8Array(1000) })
    expect(lib.status).toBe(507)
    const bk = await fetch(`${base}/api/backup`, { method: 'PUT', headers: auth, body: new Uint8Array(1000) })
    expect(bk.status).toBe(507)
    const st = await (await fetch(`${base}/api/stato`, { headers: auth })).json()
    expect(st.alarms.map((a: { key: string }) => a.key)).toContain('disco_pieno')
    expect(await died(exited)).toBe(false)
  }, 20_000)
})

describe('prova degli annunci', () => {
  it('testo troppo lungo: 400; più di una prova ogni 5 secondi: 429', async () => {
    const { port } = await startServer()
    const admin = await login(port, 'admin', 'adminadmin')
    const prova = (text: string) =>
      fetch(`http://127.0.0.1:${port}/api/annunci/prova`, { method: 'POST', headers: { Cookie: admin.cookie!, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    const long = await prova('x'.repeat(3001))
    expect(long.status).toBe(400)
    expect((await long.json()).error).toMatch(/troppo lungo/)
    // testo vuoto: risposta 400 senza usare la voce, ma la prova conta
    expect((await prova(' ')).status).toBe(400)
    const again = await prova('Ciao')
    expect(again.status).toBe(429)
  }, 20_000)
})

describe('brani caricati dal pannello', () => {
  it('due caricamenti dello stesso file insieme: tutti e due riescono e il file non è un miscuglio', async () => {
    const { port, music } = await startServer()
    const admin = await login(port, 'admin', 'adminadmin')
    const a = Buffer.alloc(3_000_000, 1)
    const b = Buffer.alloc(3_000_000, 2)
    const put = (data: Buffer) =>
      fetch(`http://127.0.0.1:${port}/api/autonoma/carica?nome=prova.mp3`, { method: 'PUT', headers: { Cookie: admin.cookie! }, body: new Uint8Array(data) })
    const [ra, rb] = await Promise.all([put(a), put(b)])
    expect([ra.status, rb.status]).toEqual([200, 200])
    const got = readFileSync(join(music, 'caricati', 'prova.mp3'))
    expect(got.equals(a) || got.equals(b)).toBe(true)
  }, 20_000)
})

describe('titolo in onda (/api/nowplaying)', () => {
  it('durante la diretta esterna i titoli della regia (che non si sente) non vanno in onda', async () => {
    const { port, internal } = await startServer({ RICONOSCIMENTO: 'no' })
    const base = `http://127.0.0.1:${port}`
    const meta = (title: string) =>
      fetch(`${base}/api/metadata`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ artist: 'Regia', title })
      })
    await meta('Prima')
    const ev = await fetch(`http://127.0.0.1:${internal}/internal/event`, { method: 'POST', body: JSON.stringify({ kind: 'esterna_collegata' }) })
    expect(ev.status).toBe(200)
    await meta('Seconda')
    const np = await (await fetch(`${base}/api/nowplaying/1`)).json()
    expect(np.live.is_live).toBe(true)
    expect(np.now_playing.song.title).toBe('Prima')
  }, 20_000)
})

describe('limiti e percorsi dei caricamenti', () => {
  it('file oltre i 300 MB dichiarati: risposta 413 col motivo, non connessione chiusa', async () => {
    const { port, exited } = await startServer()
    const admin = await login(port, 'admin', 'adminadmin')
    const first = await rawRequest(
      port,
      `PUT /api/autonoma/carica?nome=grande.mp3 HTTP/1.1\r\nHost: x\r\nCookie: ${admin.cookie}\r\nContent-Length: 400000000\r\n\r\nabc`
    )
    expect(first).toBe('HTTP/1.1 413 Payload Too Large')
    const backup = await rawRequest(port, `PUT /api/backup HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 2000000000\r\n\r\nabc`)
    expect(backup).toBe('HTTP/1.1 413 Payload Too Large')
    expect(await died(exited)).toBe(false)
  })

  it('"sposta" non sovrascrive un brano diverso della regia; se è lo stesso toglie solo la copia caricata', async () => {
    const { port, music } = await startServer()
    const base = `http://127.0.0.1:${port}`
    const admin = await login(port, 'admin', 'adminadmin')
    const auth = { Authorization: `Bearer ${TOKEN}` }
    const up = (nome: string, data: Buffer) =>
      fetch(`${base}/api/autonoma/carica?nome=${nome}`, { method: 'PUT', headers: { Cookie: admin.cookie! }, body: new Uint8Array(data) })
    const putRegia = (id: string, data: Buffer) => fetch(`${base}/api/libreria?id=${encodeURIComponent(id)}`, { method: 'PUT', headers: auth, body: new Uint8Array(data) })
    const sposta = (da: string, a: string) =>
      fetch(`${base}/api/caricati/sposta`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ da, a }) })
    expect((await up('uno.mp3', Buffer.alloc(5000, 1))).status).toBe(200)
    expect((await putRegia('regia/A/uno.mp3', Buffer.alloc(9000, 2))).status).toBe(200)
    expect((await sposta('caricati/uno.mp3', 'regia/A/uno.mp3')).status).toBe(409)
    expect(readFileSync(join(music, 'regia', 'A', 'uno.mp3')).length).toBe(9000)
    expect((await up('due.mp3', Buffer.alloc(5000, 3))).status).toBe(200)
    expect((await putRegia('regia/A/due.mp3', Buffer.alloc(5000, 3))).status).toBe(200)
    const r = await sposta('caricati/due.mp3', 'regia/A/due.mp3')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ id: 'regia/A/due.mp3', size: 5000 })
    const left = await (await fetch(`${base}/api/caricati`, { headers: auth })).json()
    expect(left.map((t: { id: string }) => t.id)).toEqual(['caricati/uno.mp3'])
  })
})

describe('ospiti', () => {
  it('con un link non si aprono connessioni senza limite dallo stesso indirizzo', async () => {
    const { port } = await startServer()
    const admin = await login(port, 'admin', 'adminadmin')
    const panel = await openWs(`ws://127.0.0.1:${port}/ws/pannello`, { Cookie: admin.cookie! })
    const invite = new Promise<any>((res) =>
      panel.on('message', (d) => {
        const m = JSON.parse(String(d))
        if (m.t === 'reply' && m.id === 'i') res(m)
      })
    )
    panel.send(JSON.stringify({ t: 'guest', id: 'i', cmd: { type: 'invite', label: 'Prova' } }))
    const { ok, data } = await invite
    expect(ok).toBe(true)
    const url = `ws://127.0.0.1:${port}/ws/ospite?t=${data.token}`
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => openWs(url)))
    const open = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<WebSocket>[]
    expect(open).toHaveLength(10)
    // chiudendone una se ne può aprire un'altra
    open[0].value.close()
    await closed(open[0].value)
    await wait(100)
    const again = await openWs(url)
    expect(again.readyState).toBe(WebSocket.OPEN)
  })
})
