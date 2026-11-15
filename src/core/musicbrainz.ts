/**
 * Completamento dei dati per il report SIAE con MusicBrainz (https://musicbrainz.org/doc/MusicBrainz_API).
 *
 * Per ogni brano: ricerca della registrazione per titolo e interprete, poi lettura della registrazione
 * con le opere collegate. Da lì arrivano ISRC (registrazione), ISWC, autori ed editore (opera).
 * MusicBrainz chiede al massimo una richiesta al secondo e un nome del programma riconoscibile:
 * non si manda nessun dato della radio o dell'utente.
 */

const BASE = 'https://musicbrainz.org/ws/2'
const USER_AGENT = 'RadioRegia/0.1'
/** Punteggio minimo della ricerca e scarto massimo di durata per accettare una registrazione. */
const MIN_SCORE = 90
const MAX_LENGTH_DIFF_S = 10
/** Ruoli dell'opera che contano come autori per SIAE. */
const AUTHOR_ROLES = new Set(['composer', 'lyricist', 'writer', 'librettist'])

export interface MbResult {
  recordingId: string
  composer: string
  publisher: string
  isrc: string
  iswc: string
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

interface Credit {
  name?: string
  joinphrase?: string
  artist?: { name?: string }
}

interface SearchRecording {
  id: string
  score?: number
  title?: string
  length?: number | null
  'artist-credit'?: Credit[]
}

interface Relation {
  type?: string
  'target-type'?: string
  artist?: { name?: string }
  label?: { name?: string }
  work?: { id?: string; title?: string; iswcs?: string[]; relations?: Relation[] }
}

interface Recording {
  id: string
  isrcs?: string[]
  relations?: Relation[]
}

/** Testo confrontabile: senza accenti, punteggiatura e parti tra parentesi ("(Remastered 2009)"). */
export function simplify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function creditName(c: Credit[] | undefined): string {
  return (c ?? []).map((x) => `${x.name ?? x.artist?.name ?? ''}${x.joinphrase ?? ''}`).join('')
}

/** Caratteri speciali della ricerca di MusicBrainz (Lucene). */
function luceneQuote(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

export function searchUrl(title: string, artist: string): string {
  const q = `recording:${luceneQuote(title)} AND artist:${luceneQuote(artist)}`
  return `${BASE}/recording?${new URLSearchParams({ query: q, fmt: 'json', limit: '5' })}`
}

export function lookupUrl(id: string): string {
  const inc = 'isrcs+work-rels+work-level-rels+artist-rels+label-rels'
  return `${BASE}/recording/${encodeURIComponent(id)}?inc=${inc}&fmt=json`
}

/** La registrazione migliore tra i risultati: titolo e interprete uguali, durata simile. */
export function pickRecording(
  results: SearchRecording[],
  t: { title: string; artist: string; duration: number }
): SearchRecording | null {
  const title = simplify(t.title)
  const artist = simplify(t.artist)
  if (!title || !artist) return null
  const ok = results.filter((r) => {
    if ((r.score ?? 0) < MIN_SCORE) return false
    if (simplify(r.title ?? '') !== title) return false
    const a = simplify(creditName(r['artist-credit']))
    if (a !== artist && !a.startsWith(`${artist} `) && !artist.startsWith(`${a} `)) return false
    if (r.length && t.duration > 0 && Math.abs(r.length / 1000 - t.duration) > MAX_LENGTH_DIFF_S) return false
    return true
  })
  if (!ok.length) return null
  // a parità di punteggio, quella con la durata più vicina
  ok.sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      Math.abs((a.length ?? 0) / 1000 - t.duration) - Math.abs((b.length ?? 0) / 1000 - t.duration)
  )
  return ok[0]
}

/** Autori, editore, ISWC e ISRC dalla registrazione letta con le opere collegate. */
export function parseRecording(rec: Recording): MbResult {
  const authors: string[] = []
  const publishers: string[] = []
  const iswcs: string[] = []
  for (const rel of rec.relations ?? []) {
    if (rel['target-type'] !== 'work' || !rel.work) continue
    for (const i of rel.work.iswcs ?? []) if (!iswcs.includes(i)) iswcs.push(i)
    for (const wr of rel.work.relations ?? []) {
      if (wr['target-type'] === 'artist' && AUTHOR_ROLES.has(wr.type ?? '') && wr.artist?.name) {
        if (!authors.includes(wr.artist.name)) authors.push(wr.artist.name)
      }
      if (wr['target-type'] === 'label' && wr.type === 'publishing' && wr.label?.name) {
        if (!publishers.includes(wr.label.name)) publishers.push(wr.label.name)
      }
    }
  }
  return {
    recordingId: rec.id,
    composer: authors.join(', '),
    publisher: publishers.join(', '),
    // una registrazione può avere più ISRC (riedizioni): basta il primo
    isrc: (rec.isrcs ?? [])[0] ?? '',
    iswc: iswcs[0] ?? ''
  }
}

export class MbError extends Error {}

/** Client con il limite di una richiesta al secondo. */
export class MusicBrainz {
  private last = 0
  private readonly fetchFn: Fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(opts: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i))
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = opts.now ?? (() => Date.now())
  }

  private async get<T>(url: string, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // si prenota il turno prima di aspettare: due ricerche insieme (ricerca completa e brani appena
      // scaricati) non partono nello stesso istante
      const now = this.now()
      const at = Math.max(now, this.last + 1100)
      this.last = at
      if (at > now) await this.sleep(at - now)
      let r: Response
      try {
        r = await this.fetchFn(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
        })
      } catch (e) {
        if (signal?.aborted) throw e
        throw new MbError('MusicBrainz non raggiungibile')
      }
      // troppe richieste o servizio occupato: si aspetta e si riprova
      if ((r.status === 503 || r.status === 429) && attempt < 3) {
        await this.sleep(5000 * (attempt + 1))
        continue
      }
      if (r.status === 404) return null as T
      if (!r.ok) throw new MbError(`MusicBrainz ha risposto con l'errore ${r.status}`)
      return (await r.json()) as T
    }
  }

  /** null = nessuna registrazione sicura. */
  async find(t: { title: string; artist: string; duration: number }, signal?: AbortSignal): Promise<MbResult | null> {
    if (!t.title.trim() || !t.artist.trim()) return null
    const s = await this.get<{ recordings?: SearchRecording[] }>(searchUrl(t.title, t.artist), signal)
    const best = pickRecording(s?.recordings ?? [], t)
    if (!best) return null
    const rec = await this.get<Recording | null>(lookupUrl(best.id), signal)
    return rec ? parseRecording(rec) : null
  }
}
