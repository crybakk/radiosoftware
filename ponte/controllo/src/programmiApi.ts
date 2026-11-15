/**
 * Indirizzi HTTP di programmi e puntate.
 *
 * Pubblici (senza accesso, come le API pubbliche dei podcast di AzuraCast, per l'app della radio):
 *   GET /api/station/<stazione>/public/podcasts
 *   GET /api/station/<stazione>/public/podcast/<programma>[/art | /episodes]
 *   GET /api/station/<stazione>/public/podcast/<programma>/episode/<puntata>[/art | /download.mp3]
 *   GET /api/pubblico   nome della radio, indirizzo d'ascolto e titolo in onda (pagine ascolta e podcast)
 * L'audio delle puntate si può solo ascoltare: niente pulsante di scaricamento nelle pagine
 * (la licenza permette lo streaming, non il download).
 *
 * Pannello (sessione):
 *   GET  /api/programmi                         programmi, puntate, registrazioni in corso
 *   POST /api/programmi                         {azione: salva|elimina|impostazioni}   (amministratori)
 *   PUT  /api/programmi/copertina?id=           copertina PNG o JPG                    (amministratori)
 *   GET  /api/puntate/audio?id=                 audio della bozza o della puntata (con Range)
 *   POST /api/puntate                           {azione: pubblica|modifica|ritira|ripubblica|elimina} (conduttori)
 *
 * Regia (token): GET /api/programmi/regia   puntate pubblicate di ogni programma (repliche)
 */
import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { apiEpisode, apiPodcast, type Episode, type Program, type Programs } from './programmi.ts'
import { isPublishing, publishEpisode, type Recorder } from './puntate.ts'
import { can, type PublicUser } from './users.ts'

export interface ProgramApiDeps {
  programs: Programs
  recorder: Pick<Recorder, 'recording'> | null
  stationName: string
  listenUrl: string
  nowPlaying: () => { artist: string; title: string } | null
  user: (req: IncomingMessage) => PublicUser | null
  sameOrigin: (req: IncomingMessage) => boolean
  authorized: (req: IncomingMessage) => boolean
  /** "https://dominio" visto dal browser. */
  base: (req: IncomingMessage) => string
  publish?: typeof publishEpisode
  log?: (s: string) => void
}

const MAX_ART_BYTES = 5 * 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...extra })
  res.end(data)
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error('richiesta troppo grande')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBody(req, 256 * 1024)).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/**
 * Il file si legge con pipeline: se sparisce o non si legge (puntata eliminata mentre la si ascolta)
 * la risposta si chiude invece di far cadere il server, e se l'ascoltatore se ne va il file si chiude.
 */
function stream(res: ServerResponse, file: string, range?: { start: number; end: number }): void {
  pipeline(createReadStream(file, range), res).catch(() => res.destroy())
}

/** File audio o immagine, con le richieste parziali (Range) che servono ai lettori per spostarsi. */
export function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type: string, extra: Record<string, string> = {}): void {
  let size: number
  try {
    const st = statSync(file)
    if (!st.isFile()) throw new Error('non è un file')
    size = st.size
  } catch {
    return json(res, 404, { error: 'file non trovato' }, extra)
  }
  const headers: Record<string, string | number> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extra }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...extra })
      return void res.end()
    }
    start = Math.max(0, start)
    end = Math.max(start, end)
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    if (req.method === 'HEAD') return void res.end()
    return stream(res, file, { start, end })
  }
  res.writeHead(200, { ...headers, 'Content-Length': size })
  if (req.method === 'HEAD') return void res.end()
  stream(res, file)
}

const PUBLIC = /^\/api\/station\/([^/]+)\/public\/(podcasts|podcast\/([^/]+)(?:\/(art(?:-\d+\.\w+)?|episodes|episode\/([^/]+)(?:\/(art(?:-\d+\.\w+)?|download(?:\.\w+)?))?))?)$/

/** Gestisce l'indirizzo se è suo; restituisce false altrimenti. */
export async function handleProgramApi(req: IncomingMessage, res: ServerResponse, url: URL, d: ProgramApiDeps): Promise<boolean> {
  const path = url.pathname
  const P = d.programs
  const log = d.log ?? ((s: string) => console.log(`[puntate] ${s}`))

  // ---------- pubbliche ----------
  const pub = PUBLIC.exec(path)
  if (pub || path === '/api/pubblico') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Max-Age': '86400' })
      res.end()
      return true
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'solo lettura' }, cors), true
    if (path === '/api/pubblico') {
      json(res, 200, { name: d.stationName, station: P.settings().station, listenUrl: d.listenUrl, nowPlaying: d.nowPlaying() }, cors)
      return true
    }
    const [, station, , pid, sub, eid, esub] = pub!
    // come AzuraCast: la stazione si indica col nome breve oppure col numero (qui c'è solo la 1)
    if (station !== P.settings().station && station !== '1') return json(res, 404, { error: 'stazione non trovata' }, cors), true
    const base = d.base(req)
    const st = P.settings().station
    if (!pid) {
      json(res, 200, P.publicPrograms().map((p) => apiPodcast(p, P.publicEpisodes(p.id).length, base, st, d.stationName)), cors)
      return true
    }
    const p = P.get(pid)
    if (!p || !p.published) return json(res, 404, { error: 'programma non trovato' }, cors), true
    if (sub?.startsWith('art') || esub?.startsWith('art')) {
      if (!p.art) return json(res, 404, { error: 'nessuna copertina' }, cors), true
      sendFile(req, res, P.artFile(p), p.art === 'png' ? 'image/png' : 'image/jpeg', { ...cors, 'Cache-Control': 'public, max-age=3600' })
      return true
    }
    if (sub === 'episodes') {
      json(res, 200, P.publicEpisodes(p.id).map((e) => apiEpisode(e, p, base, st)), cors)
      return true
    }
    if (!eid) {
      json(res, 200, apiPodcast(p, P.publicEpisodes(p.id).length, base, st, d.stationName), cors)
      return true
    }
    const e = P.publicEpisodes(p.id).find((x) => x.id === eid)
    if (!e) return json(res, 404, { error: 'puntata non trovata' }, cors), true
    if (esub?.startsWith('download')) {
      // "inline": il browser la suona, non la salva
      sendFile(req, res, P.episodeFile(e.id), 'audio/mpeg', { ...cors, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' })
      return true
    }
    json(res, 200, apiEpisode(e, p, base, st), cors)
    return true
  }

  // ---------- regia ----------
  if (path === '/api/programmi/regia') {
    if (!d.authorized(req)) return json(res, 401, { error: 'token non valido' }), true
    const st = P.settings().station
    json(
      res,
      200,
      P.list().map((p) => {
        // l'audio si legge dall'indirizzo pubblico: serve un programma visibile (dalla più recente)
        const eps = p.published ? P.publicEpisodes(p.id) : []
        return {
          id: p.id,
          title: p.title,
          episodes: eps.map((e) => ({ id: e.id, title: e.title, length: e.length, path: `/api/station/${st}/public/podcast/${p.id}/episode/${e.id}/download.mp3` }))
        }
      })
    )
    return true
  }

  // ---------- pannello ----------
  if (path !== '/api/programmi' && path !== '/api/programmi/copertina' && path !== '/api/puntate' && path !== '/api/puntate/audio') return false
  const me = d.user(req)
  if (!me) return json(res, 401, { error: 'accesso richiesto' }), true
  if (req.method !== 'GET' && !d.sameOrigin(req)) return json(res, 403, { error: 'origine non valida' }), true

  if (req.method === 'GET' && path === '/api/programmi') {
    json(res, 200, panelState(d, me))
    return true
  }
  if (req.method === 'GET' && path === '/api/puntate/audio') {
    const e = P.episode(url.searchParams.get('id') ?? '')
    if (!e) return json(res, 404, { error: 'puntata non trovata' }), true
    const file = e.status === 'bozza' || e.status === 'registrazione' ? P.rawFile(e.id) : P.episodeFile(e.id)
    sendFile(req, res, file, 'audio/mpeg', { 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' })
    return true
  }
  if (path === '/api/programmi' || path === '/api/programmi/copertina') {
    if (!can(me.role, 'utenti')) return json(res, 403, { error: 'solo gli amministratori gestiscono i programmi' }), true
    if (req.method === 'PUT' && path === '/api/programmi/copertina') {
      const p = P.setArt(url.searchParams.get('id') ?? '', await readBody(req, MAX_ART_BYTES))
      log(`${me.name} ha cambiato la copertina di ${p.title}`)
      json(res, 200, panelState(d, me))
      return true
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'metodo non valido' }), true
    const b = await readJson(req)
    if (b.azione === 'salva') {
      const p = P.saveProgram(programInput(b.programma))
      log(`${me.name} ha salvato il programma ${p.title}`)
    } else if (b.azione === 'elimina') {
      const p = P.get(String(b.id ?? ''))
      P.removeProgram(String(b.id ?? ''))
      log(`${me.name} ha eliminato il programma ${p?.title}`)
    } else if (b.azione === 'impostazioni') {
      P.setSettings({ station: b.station === undefined ? undefined : String(b.station), marginMinutes: b.marginMinutes === undefined ? undefined : Number(b.marginMinutes) })
    } else {
      return json(res, 400, { error: 'azione sconosciuta' }), true
    }
    json(res, 200, panelState(d, me))
    return true
  }
  // /api/puntate
  if (req.method !== 'POST') return json(res, 405, { error: 'metodo non valido' }), true
  if (!can(me.role, 'comandare')) return json(res, 403, { error: 'il tuo ruolo non permette di gestire le puntate' }), true
  const b = await readJson(req)
  const id = String(b.id ?? '')
  const e = P.episode(id)
  if (!e) return json(res, 404, { error: 'puntata non trovata' }), true
  if (e.status === 'registrazione') return json(res, 400, { error: 'la puntata si sta ancora registrando' }), true
  if (isPublishing(id)) return json(res, 409, { error: 'la puntata si sta pubblicando: aspetta qualche secondo' }), true
  const title = String(b.title ?? '')
  const description = String(b.description ?? '')
  switch (b.azione) {
    case 'pubblica':
      await (d.publish ?? publishEpisode)(P, id, { from: Number(b.inizio), to: Number(b.fine), title, description })
      log(`${me.name} ha pubblicato ${title || e.title}`)
      break
    case 'modifica':
      P.editEpisode(id, { title, description })
      break
    case 'ritira':
    case 'ripubblica':
      P.setVisible(id, b.azione === 'ripubblica')
      log(`${me.name}: ${b.azione} ${e.title}`)
      break
    case 'elimina':
      P.removeEpisode(id)
      log(`${me.name} ha eliminato la puntata ${e.title}`)
      break
    default:
      return json(res, 400, { error: 'azione sconosciuta' }), true
  }
  json(res, 200, panelState(d, me))
  return true
}

function programInput(v: unknown): Partial<Program> {
  const o = (v ?? {}) as Record<string, unknown>
  const slots = Array.isArray(o.slots) ? (o.slots as Record<string, unknown>[]) : []
  return {
    id: o.id ? String(o.id) : undefined,
    title: String(o.title ?? ''),
    description: String(o.description ?? ''),
    author: String(o.author ?? ''),
    record: o.record !== false,
    published: o.published !== false,
    slots: slots.slice(0, 50).map((s) => ({
      days: Array.isArray(s.days) ? s.days.map(Number).filter(Number.isInteger) : [],
      start: String(s.start ?? ''),
      end: String(s.end ?? '')
    }))
  }
}

function panelState(d: ProgramApiDeps, me: PublicUser): Record<string, unknown> {
  const P = d.programs
  return {
    settings: P.settings(),
    programs: P.list(),
    episodes: P.episodes() as Episode[],
    recording: d.recorder?.recording() ?? [],
    canAdmin: can(me.role, 'utenti'),
    canEdit: can(me.role, 'comandare')
  }
}
