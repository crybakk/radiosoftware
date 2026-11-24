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
 *   GET  /api/puntate/audio?id=                 audio della bozza o della puntata (con Range; bozze e
 *                                               registrazioni in corso solo per chi può comandare)
 *   POST /api/puntate                           {azione: pubblica|modifica|ritira|ripubblica|elimina} (conduttori)
 *
 * Regia (token): GET/POST /api/programmi/regia/gestione   programmi completi; {azione: salva|elimina}
 *                GET/PUT  /api/programmi/regia/copertina?id= copertina del programma
 *                GET /api/programmi/regia   puntate pubblicate di ogni programma (repliche), fasce e
 *                                            "va in onda dallo studio" (registrazione in regia)
 *                POST /api/programmi/regia/fine            fine della registrazione in regia: si tiene
 *                                                         quella del ponte o serve il file (puntateRegia.ts)
 *                PUT  /api/programmi/regia/registrazione?… il file MP3 della registrazione della regia
 *
 * App Radio Esterna (sessione, da conduttore in su): stesse regole della regia dello studio, con i collegamenti
 * dell'app al posto di quelli della regia.
 *                GET  /api/programmi/esterna                elenco dei programmi (id e nome)
 *                POST /api/programmi/esterna/inizio         {programId}: il ponte registra il programma da adesso
 *                POST /api/programmi/esterna/fine           come /api/programmi/regia/fine (e ferma la registrazione)
 *                PUT  /api/programmi/esterna/registrazione?… il file MP3 registrato dall'app
 */
import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { apiEpisode, apiPodcast, type Episode, type Program, type Programs } from './programmi.ts'
import { isPublishing, publishEpisode, type Recorder } from './puntate.ts'
import { leggiFine, type PuntateRegia } from './puntateRegia.ts'
import { can, type PublicUser } from './users.ts'

export interface ProgramApiDeps {
  programs: Programs
  recorder: Pick<Recorder, 'recording' | 'startManual' | 'stopManual'> | null
  stationName: string
  listenUrl: string
  nowPlaying: () => { artist: string; title: string } | null
  user: (req: IncomingMessage) => PublicUser | null
  sameOrigin: (req: IncomingMessage) => boolean
  authorized: (req: IncomingMessage) => boolean
  /** "https://dominio" visto dal browser. */
  base: (req: IncomingMessage) => string
  publish?: typeof publishEpisode
  /** Registrazioni della regia dello studio (assente = funzione spenta). */
  regia?: PuntateRegia
  /** Registrazioni dell'app Radio Esterna (assente = funzione spenta). */
  esterna?: PuntateRegia
  /** Salva il corpo della richiesta in un file (in streaming, con limite di dimensione). */
  saveUpload?: (req: IncomingMessage, file: string) => Promise<unknown>
  /** Motivo per rifiutare un file (disco quasi pieno), null se c'è spazio. */
  noSpace?: () => string | null
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
          // fasce: per {programma} e {prossimo_programma} negli annunci della regia
          slots: p.slots,
          // registrazione in regia dei programmi fatti dallo studio, con lo stesso margine del ponte
          studio: p.studio === true,
          marginMinutes: P.settings().marginMinutes,
          episodes: eps.map((e) => ({ id: e.id, title: e.title, length: e.length, path: `/api/station/${st}/public/podcast/${p.id}/episode/${e.id}/download.mp3` }))
        }
      })
    )
    return true
  }

  // gestione dei programmi dalla regia (richiesta del 24/11/2026): come gli amministratori del pannello
  if (path === '/api/programmi/regia/gestione' || path === '/api/programmi/regia/copertina') {
    if (!d.authorized(req)) return json(res, 401, { error: 'token non valido' }), true
    const state = () => ({ settings: P.settings(), programs: P.list() })
    if (path === '/api/programmi/regia/copertina') {
      const id = url.searchParams.get('id') ?? ''
      if (req.method === 'GET') {
        const p = P.get(id)
        if (!p?.art) return json(res, 404, { error: 'copertina non presente' }), true
        sendFile(req, res, P.artFile(p), p.art === 'png' ? 'image/png' : 'image/jpeg', { 'Cache-Control': 'no-store' })
        return true
      }
      if (req.method !== 'PUT') return json(res, 405, { error: 'metodo non valido' }), true
      const p = P.setArt(id, await readBody(req, MAX_ART_BYTES))
      log(`la regia ha cambiato la copertina di ${p.title}`)
      json(res, 200, state())
      return true
    }
    if (req.method === 'GET') return json(res, 200, state(), { 'Cache-Control': 'no-store' }), true
    if (req.method !== 'POST') return json(res, 405, { error: 'metodo non valido' }), true
    const b = await readJson(req)
    if (b.azione === 'salva') {
      const p = P.saveProgram(programInput(b.programma))
      log(`la regia ha salvato il programma ${p.title}`)
    } else if (b.azione === 'elimina') {
      const p = P.get(String(b.id ?? ''))
      P.removeProgram(String(b.id ?? ''))
      log(`la regia ha eliminato il programma ${p?.title}`)
    } else {
      return json(res, 400, { error: 'azione sconosciuta' }), true
    }
    json(res, 200, state())
    return true
  }

  if (path === '/api/programmi/regia/fine' || path === '/api/programmi/regia/registrazione') {
    if (!d.authorized(req)) return json(res, 401, { error: 'token non valido' }), true
    if (!d.regia) return json(res, 503, { error: 'server da aggiornare: non riceve le registrazioni della regia' }), true
    if (req.method === 'POST' && path === '/api/programmi/regia/fine') {
      json(res, 200, await d.regia.fine(leggiFine(await readJson(req))))
      return true
    }
    if (req.method === 'PUT' && path === '/api/programmi/regia/registrazione') {
      const f = leggiFine(Object.fromEntries(url.searchParams))
      if (!P.get(f.programId)) return json(res, 404, { error: 'programma non trovato' }), true
      const full = d.noSpace?.() ?? null
      if (full) return json(res, 507, { error: full }), true
      if (!d.saveUpload) return json(res, 503, { error: 'caricamento non disponibile' }), true
      const id = d.regia.nuovoId()
      await d.saveUpload(req, P.rawFile(id))
      const e = await d.regia.ricevuto(id, f)
      json(res, 200, { ok: true, id: e.id, status: e.status })
      return true
    }
    return json(res, 405, { error: 'metodo non valido' }), true
  }

  if (path === '/api/programmi/esterna' || path.startsWith('/api/programmi/esterna/')) {
    const me = d.user(req)
    if (!me) return json(res, 401, { error: 'accesso richiesto' }), true
    if (!can(me.role, 'comandare')) return json(res, 403, { error: 'il tuo ruolo non permette di andare in onda' }), true
    if (req.method !== 'GET' && !d.sameOrigin(req)) return json(res, 403, { error: 'origine non valida' }), true
    if (req.method === 'GET' && path === '/api/programmi/esterna') {
      json(res, 200, P.list().map((p) => ({ id: p.id, title: p.title })), { 'Cache-Control': 'no-store' })
      return true
    }
    if (!d.esterna) return json(res, 503, { error: 'server da aggiornare: non riceve le registrazioni di Radio Esterna' }), true
    if (req.method === 'POST' && path === '/api/programmi/esterna/inizio') {
      const programId = String((await readJson(req)).programId ?? '')
      if (!P.get(programId)) return json(res, 404, { error: 'programma non trovato' }), true
      if (!d.recorder) return json(res, 200, { ok: false, motivo: 'registrazione delle puntate spenta sul server' }), true
      try {
        const id = d.recorder.startManual(programId)
        d.log?.(`${me.name} registra ${P.get(programId)?.title} da Radio Esterna`)
        json(res, 200, { ok: true, id })
      } catch (e) {
        json(res, 200, { ok: false, motivo: e instanceof Error ? e.message : String(e) })
      }
      return true
    }
    if (req.method === 'POST' && path === '/api/programmi/esterna/fine') {
      const f = leggiFine(await readJson(req))
      // prima si decide (la registrazione del ponte è ancora "in corso": si pubblica appena si chiude), poi si ferma
      const r = await d.esterna.fine(f)
      await d.recorder?.stopManual(f.programId)
      json(res, 200, r)
      return true
    }
    if (req.method === 'PUT' && path === '/api/programmi/esterna/registrazione') {
      const f = leggiFine(Object.fromEntries(url.searchParams))
      if (!P.get(f.programId)) return json(res, 404, { error: 'programma non trovato' }), true
      const full = d.noSpace?.() ?? null
      if (full) return json(res, 507, { error: full }), true
      if (!d.saveUpload) return json(res, 503, { error: 'caricamento non disponibile' }), true
      // se il ponte stava ancora registrando lo stesso programma a mano, si ferma: si usa il file dell'app
      await d.recorder?.stopManual(f.programId)
      const id = d.esterna.nuovoId()
      await d.saveUpload(req, P.rawFile(id))
      const e = await d.esterna.ricevuto(id, f)
      json(res, 200, { ok: true, id: e.id, status: e.status })
      return true
    }
    return json(res, 405, { error: 'metodo non valido' }), true
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
    // bozze e registrazioni in corso: non per gli ospiti del pannello (solo lettura)
    if (!e || (isDraft(e) && !can(me.role, 'comandare'))) return json(res, 404, { error: 'puntata non trovata' }), true
    const file = isDraft(e) ? P.rawFile(e.id) : P.episodeFile(e.id)
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
  if (e.status === 'elaborazione' || isPublishing(id)) return json(res, 409, { error: 'la puntata si sta pubblicando: aspetta qualche secondo' }), true
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
    studio: o.studio === true,
    published: o.published !== false,
    slots: slots.slice(0, 50).map((s) => ({
      days: Array.isArray(s.days) ? s.days.map(Number).filter(Number.isInteger) : [],
      start: String(s.start ?? ''),
      end: String(s.end ?? '')
    }))
  }
}

/** Bozza da rivedere o registrazione in corso (non ancora pubblicata). */
const isDraft = (e: Episode): boolean => e.status === 'bozza' || e.status === 'registrazione' || e.status === 'elaborazione'

function panelState(d: ProgramApiDeps, me: PublicUser): Record<string, unknown> {
  const P = d.programs
  // gli ospiti del pannello (solo lettura) vedono solo le puntate pubblicate (anche quelle ritirate)
  const all = can(me.role, 'comandare')
  return {
    settings: P.settings(),
    programs: P.list(),
    episodes: P.episodes().filter((e) => all || !isDraft(e)),
    recording: all ? (d.recorder?.recording() ?? []) : [],
    canAdmin: can(me.role, 'utenti'),
    canEdit: can(me.role, 'comandare')
  }
}
