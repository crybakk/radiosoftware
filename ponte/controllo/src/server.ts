/**
 * Servizio di controllo del ponte.
 *
 * Porta pubblica (CONTROLLO_PORTA, predefinita 9080), protetta da token:
 *   POST /api/heartbeat   segnali di vita e stato dalla regia
 *   POST /api/metadata    titolo/artista in onda → Liquidsoap → AzuraCast
 *   PUT  /api/backup      copia del database della regia
 *   GET  /api/backup      elenco copie;  GET /api/backup/<nome> scarica una copia
 *   GET  /api/stato       stato del ponte e allarmi attivi
 *   POST /api/test-notifica  invia una notifica di prova
 *   GET  /health          senza token, per i controlli automatici
 *   WS   /ws/regia        canale in tempo reale con la regia (autenticazione col token nel primo messaggio)
 *
 * Pannello remoto (accesso con nome e password, sessione in un cookie):
 *   GET  /                pagine del pannello
 *   POST /api/login, POST /api/logout, GET /api/io
 *   GET/POST /api/utenti, DELETE /api/utenti/<nome>   (solo amministratori)
 *   WS   /ws/pannello     stato della regia e comandi
 *
 * Con CERTIFICATO_TLS e CHIAVE_TLS (per esempio quelli di AzuraCast) la porta pubblica usa HTTPS.
 * Porta interna 8091 (solo rete Docker): POST /internal/event da Liquidsoap.
 */
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { Alarms, DEFAULT_ALARM_CONFIG, type AlarmKey } from './alarms.ts'
import { Notifier } from './notifier.ts'
import { Relay } from './relay.ts'
import { can, ROLES, sameSecret, Users, type PublicUser, type Role } from './users.ts'

const env = (k: string, d = ''): string => process.env[k] ?? d
const num = (k: string, d: number): number => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && process.env[k] !== '' ? v : d
}

const TOKEN = env('CONTROLLO_TOKEN')
const PUBLIC_PORT = num('CONTROLLO_PORTA', 9080)
const INTERNAL_PORT = num('CONTROLLO_PORTA_INTERNA', 8091)
const LIQUIDSOAP = env('LIQUIDSOAP_INTERNO', 'http://liquidsoap:8092')
const DATA_DIR = env('CARTELLA_DATI', '/data')
const BACKUP_DIR = join(DATA_DIR, 'backup')
const BACKUP_KEEP = num('BACKUP_DA_TENERE', 14)
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024
const CERT_FILE = env('CERTIFICATO_TLS')
const KEY_FILE = env('CHIAVE_TLS')
const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pannello')

if (TOKEN.length < 16) {
  console.error('CONTROLLO_TOKEN mancante o troppo corto (almeno 16 caratteri): il servizio non parte.')
  process.exit(1)
}

const notifier = new Notifier({
  telegramToken: env('TELEGRAM_BOT_TOKEN'),
  telegramChatId: env('TELEGRAM_CHAT_ID'),
  smtpHost: env('SMTP_HOST'),
  smtpPort: num('SMTP_PORTA', 587),
  smtpUser: env('SMTP_UTENTE'),
  smtpPassword: env('SMTP_PASSWORD'),
  smtpSecure: env('SMTP_SSL', 'no') === 'si',
  emailFrom: env('EMAIL_MITTENTE'),
  emailTo: env('EMAIL_DESTINATARI'),
  stationName: env('NOME_RADIO', 'Radio')
})

const alarms = new Alarms(
  {
    disconnectedSeconds: num('ALLARME_SCOLLEGATO_SECONDI', DEFAULT_ALARM_CONFIG.disconnectedSeconds),
    heartbeatSeconds: num('ALLARME_REGIA_MUTA_SECONDI', DEFAULT_ALARM_CONFIG.heartbeatSeconds),
    flapCount: num('ALLARME_RICONNESSIONI', DEFAULT_ALARM_CONFIG.flapCount)
  },
  (text: string, key: AlarmKey | 'esterna', open: boolean) => {
    console.log(`[allarme] ${open ? 'APERTO' : 'chiuso'} ${key}: ${text}`)
    void notifier.send(text)
    // il pannello vede gli allarmi aggiornati (dopo che la classe ha aggiornato il suo stato)
    queueMicrotask(() => relay.setAlarms(alarms.status().alarms))
  }
)
setInterval(() => alarms.tick(), 2000)

const relay = new Relay(TOKEN)
relay.onStudioChange = (c) => console.log(`[regia] canale di controllo ${c ? 'collegato' : 'scollegato'}`)
// segnale di vita a livello di applicazione: la regia capisce se il canale è ancora vivo
setInterval(() => relay.pingStudio(), 15_000)

await mkdir(DATA_DIR, { recursive: true })
const users = new Users(join(DATA_DIR, 'utenti.json'), join(DATA_DIR, 'sessioni.json'))
if (users.count() === 0) {
  const pw = env('PANNELLO_ADMIN_PASSWORD')
  if (pw.length >= 8) {
    users.save('admin', 'amministratore', pw)
    console.log('Creato l\'utente "admin" del pannello remoto')
  } else {
    console.log('Nessun utente del pannello: imposta PANNELLO_ADMIN_PASSWORD (almeno 8 caratteri) per creare "admin"')
  }
}

let lastStudio: Record<string, unknown> | null = null
let lastMetadata: { artist: string; title: string; at: string } | null = null

// ---------- utilità HTTP ----------

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error('richiesta troppo grande')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

function authorized(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? ''
  const m = /^Bearer (.+)$/.exec(h)
  if (!m) return false
  return sameSecret(m[1], TOKEN)
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k !== name) continue
    try {
      return decodeURIComponent(v.join('='))
    } catch {
      return undefined // codifica non valida: come se il cookie non ci fosse
    }
  }
  return undefined
}

function sessionUser(req: IncomingMessage): PublicUser | null {
  return users.session(cookie(req, 'sessione'))
}

/** Le connessioni dal browser devono arrivare dalla pagina del pannello stesso. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

// troppi tentativi di accesso sbagliati dallo stesso indirizzo: pausa di un minuto
// (il tentativo si conta prima di leggere la richiesta, e si toglie se l'accesso riesce:
//  così tante richieste in parallelo non passano tutte il controllo)
const failedLogins = new Map<string, number[]>()
function recentAttempts(ip: string): number[] {
  const now = Date.now()
  const list = (failedLogins.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (list.length) failedLogins.set(ip, list)
  else failedLogins.delete(ip)
  return list
}
/** Riserva un tentativo; restituisce null se ce ne sono già troppi, altrimenti la funzione per annullarlo. */
function reserveAttempt(ip: string): (() => void) | null {
  const list = recentAttempts(ip)
  if (list.length >= 5) return null
  const t = Date.now()
  list.push(t)
  failedLogins.set(ip, list)
  return () => {
    const l = failedLogins.get(ip)
    const i = l ? l.indexOf(t) : -1
    if (i >= 0) l!.splice(i, 1)
    if (l && !l.length) failedLogins.delete(ip)
  }
}
// pulizia degli indirizzi che non tentano più
setInterval(() => {
  for (const ip of [...failedLogins.keys()]) recentAttempts(ip)
}, 60_000)

// WebSocket dei pannelli aperti con ogni sessione: all'uscita si chiudono
const panelSockets = new Map<string, Set<WebSocket>>()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
}

async function serveStatic(res: ServerResponse, path: string): Promise<boolean> {
  const name = path === '/' ? 'index.html' : path.slice(1)
  if (!/^[\w.-]+$/.test(name)) return false
  const file = join(PANEL_DIR, name)
  const data = await readFile(file).catch(() => null)
  if (!data) return false
  res.writeHead(200, {
    'Content-Type': MIME[extname(name)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'"
  })
  res.end(data)
  return true
}

// ---------- backup ----------

async function listBackups(): Promise<{ name: string; size: number; date: string }[]> {
  await mkdir(BACKUP_DIR, { recursive: true })
  const names = (await readdir(BACKUP_DIR)).filter((n) => /^radio-[\dT-]+\.db$/.test(n)).sort().reverse()
  const out = []
  for (const name of names) {
    const st = await stat(join(BACKUP_DIR, name))
    out.push({ name, size: st.size, date: st.mtime.toISOString() })
  }
  return out
}

async function saveBackup(req: IncomingMessage): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `radio-${stamp}.db`
  // nome provvisorio unico: due invii nello stesso secondo non si mescolano
  const tmp = join(BACKUP_DIR, `.${name}.${randomBytes(6).toString('hex')}.part`)
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > MAX_BACKUP_BYTES) req.destroy(new Error('backup troppo grande'))
  })
  try {
    await pipeline(req, createWriteStream(tmp))
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  if (size < 100) {
    await rm(tmp, { force: true })
    throw new Error('backup vuoto')
  }
  await rename(tmp, join(BACKUP_DIR, name))
  const all = await listBackups()
  for (const old of all.slice(BACKUP_KEEP)) await rm(join(BACKUP_DIR, old.name), { force: true })
  return name
}

// ---------- server pubblico ----------

function loadCert(): { cert: Buffer; key: Buffer } | null {
  if (!CERT_FILE || !KEY_FILE || !existsSync(CERT_FILE) || !existsSync(KEY_FILE)) return null
  try {
    return { cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) }
  } catch (e) {
    // per esempio permessi del file: meglio partire in HTTP che non partire
    console.error(`Certificato non leggibile, uso HTTP: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
const certs = loadCert()
const tls = certs !== null

async function handlePublic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/health') return json(res, 200, { ok: true })
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (await serveStatic(res, url.pathname)) return
      return json(res, 404, { error: 'non trovato' })
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'non trovato' })

    // --- pannello remoto (sessione) ---
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'origine non valida' })
      const ip = req.socket.remoteAddress ?? ''
      const cancel = reserveAttempt(ip)
      if (!cancel) return json(res, 429, { error: 'Troppi tentativi: riprova tra un minuto' })
      const body = await readJson(req, 4096)
      const s = await users.login(String(body.name ?? '').trim(), String(body.password ?? ''))
      if (!s) return json(res, 401, { error: 'Nome o password errati' })
      cancel()
      res.setHeader(
        'Set-Cookie',
        `sessione=${s.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}${tls ? '; Secure' : ''}`
      )
      return json(res, 200, { user: s.user })
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const t = cookie(req, 'sessione')
      if (t) {
        users.logout(t)
        for (const ws of panelSockets.get(t) ?? []) ws.close(4003, 'sessione chiusa')
        panelSockets.delete(t)
      }
      res.setHeader('Set-Cookie', 'sessione=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/api/io' || url.pathname.startsWith('/api/utenti')) {
      const me = sessionUser(req)
      if (!me) return json(res, 401, { error: 'accesso richiesto' })
      if (url.pathname === '/api/io') return json(res, 200, { user: me })
      if (!can(me.role, 'utenti')) return json(res, 403, { error: 'solo gli amministratori gestiscono gli utenti' })
      if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'origine non valida' })
      if (req.method === 'GET' && url.pathname === '/api/utenti') return json(res, 200, { users: users.list(), roles: ROLES })
      if (req.method === 'POST' && url.pathname === '/api/utenti') {
        const body = await readJson(req, 4096)
        const name = String(body.name ?? '').trim()
        const password = body.password ? String(body.password) : undefined
        const before = users.get(name)
        const u = users.save(name, String(body.role ?? '') as Role, password)
        if (password) relay.kick(u.name)
        // cambio di ruolo: il pannello si ricollega e riceve il ruolo nuovo
        else if (before && before.role !== u.role) relay.kick(u.name, 4002, 'ruolo cambiato')
        return json(res, 200, { user: u, users: users.list() })
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/utenti/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/utenti/'.length))
        if (name.toLowerCase() === me.name.toLowerCase()) return json(res, 400, { error: 'non puoi eliminare te stesso' })
        users.remove(name)
        relay.kick(name)
        return json(res, 200, { users: users.list() })
      }
      return json(res, 404, { error: 'non trovato' })
    }

    // --- regia (token) ---
    if (!authorized(req)) return json(res, 401, { error: 'token non valido' })

    if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
      lastStudio = { ...(await readJson(req)), receivedAt: new Date().toISOString() }
      alarms.onHeartbeat()
      relay.setAlarms(alarms.status().alarms)
      return json(res, 200, { ok: true, alarms: alarms.status().alarms })
    }
    if (req.method === 'POST' && url.pathname === '/api/metadata') {
      const body = await readJson(req)
      const artist = String(body.artist ?? '').slice(0, 300)
      const title = String(body.title ?? '').slice(0, 300)
      lastMetadata = { artist, title, at: new Date().toISOString() }
      const r = await fetch(`${LIQUIDSOAP}/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artist, title }),
        signal: AbortSignal.timeout(5000)
      }).catch(() => null)
      return json(res, r?.ok ? 200 : 502, { ok: !!r?.ok })
    }
    if (req.method === 'PUT' && url.pathname === '/api/backup') {
      const name = await saveBackup(req)
      return json(res, 200, { ok: true, name })
    }
    if (req.method === 'GET' && url.pathname === '/api/backup') return json(res, 200, await listBackups())
    if (req.method === 'GET' && url.pathname.startsWith('/api/backup/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/backup/'.length))
      if (!/^radio-[\dT-]+\.db$/.test(name)) return json(res, 400, { error: 'nome non valido' })
      const file = join(BACKUP_DIR, name)
      const st = await stat(file).catch(() => null)
      if (!st) return json(res, 404, { error: 'backup non trovato' })
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${name}"`
      })
      // se la lettura si interrompe la risposta viene chiusa (vedi sotto)
      return await pipeline(createReadStream(file), res)
    }
    if (req.method === 'GET' && url.pathname === '/api/stato') {
      const ls = await fetch(`${LIQUIDSOAP}/stato`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json())
        .catch(() => null)
      return json(res, 200, {
        ...alarms.status(),
        liquidsoap: ls,
        studio: lastStudio,
        metadata: lastMetadata,
        notifiche: notifier.channels()
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/test-notifica') {
      const results = await notifier.send('🔔 Notifica di prova dal ponte di Radio Regia.')
      return json(res, 200, { ok: results.every((r) => r.ok), results })
    }
    return json(res, 404, { error: 'non trovato' })
  } catch (e) {
    // risposta già iniziata (per esempio un backup in download): non si può che chiuderla
    if (res.headersSent) return void res.destroy()
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) })
  }
}

const onRequest = (req: IncomingMessage, res: ServerResponse): void =>
  void handlePublic(req, res).catch(() => res.destroy())
const publicServer = certs ? createHttpsServer(certs, onRequest) : createServer(onRequest)

if (tls) {
  // il certificato di AzuraCast si rinnova da solo: lo ricarichiamo ogni 12 ore
  setInterval(() => {
    const c = loadCert()
    if (c) (publicServer as ReturnType<typeof createHttpsServer>).setSecureContext(c)
  }, 12 * 3600_000)
}

// ---------- WebSocket: regia e pannelli ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

/** `valid` (facoltativo) si ricontrolla a ogni segnale di vita: se diventa falso la connessione si chiude. */
function wire(ws: WebSocket, h: { message: (raw: string) => void; close: () => void }, valid?: () => boolean): void {
  // un messaggio malformato non deve mai far cadere il servizio
  ws.on('message', (data) => {
    try {
      h.message(String(data))
    } catch (e) {
      console.error(`[ws] messaggio scartato: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  ws.on('close', () => {
    try {
      h.close()
    } catch (e) {
      console.error(`[ws] errore in chiusura: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  ws.on('error', () => ws.terminate())
  // segnale di vita: le connessioni morte (4G caduto) vengono chiuse
  let alive = true
  ws.on('pong', () => (alive = true))
  const ping = setInterval(() => {
    if (!alive) return ws.terminate()
    if (valid && !valid()) return ws.close(4003, 'sessione scaduta')
    alive = false
    ws.ping()
  }, 15_000)
  ws.on('close', () => clearInterval(ping))
}

publicServer.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy())
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/ws/regia') {
      return wss.handleUpgrade(req, socket, head, (ws) => wire(ws, relay.attachStudio(ws)))
    }
    if (url.pathname === '/ws/pannello') {
      const token = cookie(req, 'sessione')
      const me = users.session(token)
      if (!token || !me || !sameOrigin(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return socket.destroy()
      }
      return wss.handleUpgrade(req, socket, head, (ws) => {
        const set = panelSockets.get(token) ?? new Set<WebSocket>()
        panelSockets.set(token, set)
        set.add(ws)
        ws.on('close', () => {
          set.delete(ws)
          if (!set.size && panelSockets.get(token) === set) panelSockets.delete(token)
        })
        // a ogni comando si usa il ruolo attuale della sessione (cambiato, scaduta, utente eliminato)
        const current = (): PublicUser | null => users.session(token)
        wire(ws, relay.attachPanel(ws, me, current), () => current() !== null)
      })
    }
    socket.destroy()
  } catch (e) {
    console.error(`[ws] richiesta di collegamento non valida: ${e instanceof Error ? e.message : String(e)}`)
    socket.destroy()
  }
})

// ---------- server interno (Liquidsoap) ----------

const internalServer = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/internal/event') {
      const body = await readJson(req)
      const kind = String(body.kind ?? '')
      console.log(`[evento] ${kind} ${body.detail ?? ''}`)
      alarms.onEvent(kind, String(body.detail ?? ''))
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'non trovato' })
  } catch (e) {
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) })
  }
})

publicServer.listen(PUBLIC_PORT, () => console.log(`Controllo in ascolto sulla porta ${PUBLIC_PORT}${tls ? ' (HTTPS)' : ''}`))
internalServer.listen(INTERNAL_PORT, () => console.log(`Eventi interni sulla porta ${INTERNAL_PORT}`))

const shutdown = (): void => {
  publicServer.close()
  internalServer.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
