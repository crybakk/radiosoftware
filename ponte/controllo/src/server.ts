/**
 * Servizio di controllo del ponte.
 *
 * Porta pubblica (CONTROLLO_PORTA, predefinita 8090), protetta da token:
 *   POST /api/heartbeat   segnali di vita e stato dalla regia
 *   POST /api/metadata    titolo/artista in onda → Liquidsoap → AzuraCast
 *   PUT  /api/backup      copia del database della regia
 *   GET  /api/backup      elenco copie;  GET /api/backup/<nome> scarica una copia
 *   GET  /api/stato       stato del ponte e allarmi attivi
 *   POST /api/test-notifica  invia una notifica di prova
 *   GET  /health          senza token, per i controlli automatici
 *
 * Porta interna 8091 (solo rete Docker): POST /internal/event da Liquidsoap.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { timingSafeEqual } from 'node:crypto'
import { Alarms, DEFAULT_ALARM_CONFIG, type AlarmKey } from './alarms.ts'
import { Notifier } from './notifier.ts'

const env = (k: string, d = ''): string => process.env[k] ?? d
const num = (k: string, d: number): number => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && process.env[k] !== '' ? v : d
}

const TOKEN = env('CONTROLLO_TOKEN')
const PUBLIC_PORT = num('CONTROLLO_PORTA', 8090)
const INTERNAL_PORT = 8091
const LIQUIDSOAP = env('LIQUIDSOAP_INTERNO', 'http://liquidsoap:8092')
const DATA_DIR = env('CARTELLA_DATI', '/data')
const BACKUP_DIR = join(DATA_DIR, 'backup')
const BACKUP_KEEP = num('BACKUP_DA_TENERE', 14)
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024

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
  (text: string, key: AlarmKey, open: boolean) => {
    console.log(`[allarme] ${open ? 'APERTO' : 'chiuso'} ${key}: ${text}`)
    void notifier.send(text)
  }
)
setInterval(() => alarms.tick(), 2000)

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
  const a = Buffer.from(m[1])
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
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
  const tmp = join(BACKUP_DIR, `.${name}.part`)
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

const publicServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true })
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'non trovato' })
    if (!authorized(req)) return json(res, 401, { error: 'token non valido' })

    if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
      lastStudio = { ...(await readJson(req)), receivedAt: new Date().toISOString() }
      alarms.onHeartbeat()
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
      return void createReadStream(file).pipe(res)
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
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) })
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

publicServer.listen(PUBLIC_PORT, () => console.log(`Controllo in ascolto sulla porta ${PUBLIC_PORT}`))
internalServer.listen(INTERNAL_PORT, () => console.log(`Eventi interni sulla porta ${INTERNAL_PORT}`))

const shutdown = (): void => {
  publicServer.close()
  internalServer.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
