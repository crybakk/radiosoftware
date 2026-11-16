/**
 * Completamento dei dati per il report SIAE con MusicBrainz (https://musicbrainz.org/doc/MusicBrainz_API).
 *
 * Per ogni brano: ricerca della registrazione per titolo e interprete, poi lettura della registrazione
 * con le opere collegate. Da lì arrivano ISRC (registrazione), ISWC, autori ed editore (opera).
 * Dalla stessa lettura arrivano anche i generi (quelli ufficiali di MusicBrainz, non le etichette libere)
 * e l'anno della prima uscita; se la registrazione non ha generi si usano quelli dell'artista.
 * MusicBrainz chiede al massimo una richiesta al secondo e un nome del programma riconoscibile:
 * non si manda nessun dato della radio o dell'utente.
 */

import { sleepOrAbort } from './webLimit'

const BASE = 'https://musicbrainz.org/ws/2'
const USER_AGENT = 'RadioRegia/0.1'

/** Nome del programma per MusicBrainz, con il contatto scelto nelle Impostazioni (lo chiede MusicBrainz). */
export function mbUserAgent(contact: string): string {
  const c = contact.replace(/[()\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
  return c ? `${USER_AGENT} ( ${c} )` : USER_AGENT
}
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
  /** Generi della registrazione, dal più votato (al massimo 5). */
  genres: string[]
  /** Anno della prima uscita, null se non si sa. */
  year: number | null
  /** Artisti accreditati (per i generi dell'artista quando la registrazione non ne ha). */
  artistIds: string[]
}

/** Massimo numero di generi tenuti per brano o artista. */
const MAX_GENRES = 5

type Fetch = (url: string, init: RequestInit) => Promise<Response>

interface Credit {
  name?: string
  joinphrase?: string
  artist?: { id?: string; name?: string }
}

interface Genre {
  name?: string
  count?: number
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
  genres?: Genre[]
  'first-release-date'?: string
  'artist-credit'?: Credit[]
}

/** I generi più votati, in minuscolo, senza doppioni. */
export function topGenres(list: Genre[] | undefined): string[] {
  const out: string[] = []
  for (const g of [...(list ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) {
    const n = (g.name ?? '').trim().toLowerCase()
    if (n && !out.includes(n)) out.push(n)
    if (out.length >= MAX_GENRES) break
  }
  return out
}

/**
 * Testo confrontabile: senza accenti, punteggiatura e parti tra parentesi ("(Remastered 2009)").
 * "&", "e" e "and" tra due parole non contano: "Simon and Garfunkel" = "Simon & Garfunkel" e
 * "Jovanotti, Fiorello" = "Jovanotti & Fiorello".
 */
export function simplify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/ (?:(?:e|and) )+/g, ' ')
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
  const inc = 'isrcs+work-rels+work-level-rels+artist-rels+label-rels+genres+artist-credits'
  return `${BASE}/recording/${encodeURIComponent(id)}?inc=${inc}&fmt=json`
}

export function artistUrl(id: string): string {
  return `${BASE}/artist/${encodeURIComponent(id)}?inc=genres&fmt=json`
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
    iswc: iswcs[0] ?? '',
    genres: topGenres(rec.genres),
    year: yearOf(rec['first-release-date']),
    artistIds: (rec['artist-credit'] ?? []).map((c) => c.artist?.id ?? '').filter(Boolean)
  }
}

function yearOf(d: string | undefined): number | null {
  const y = Number(/^(\d{4})/.exec(d ?? '')?.[1])
  return y >= 1900 && y <= 2100 ? y : null
}

export class MbError extends Error {}

/** Client con il limite di una richiesta al secondo. */
export class MusicBrainz {
  private readonly contact: () => string
  private last = 0
  private readonly fetchFn: Fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(
    opts: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; contact?: () => string } = {}
  ) {
    this.contact = opts.contact ?? (() => '')
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
      if (at > now) await sleepOrAbort(this.sleep, at - now, signal)
      let r: Response
      try {
        r = await this.fetchFn(url, {
          headers: { 'User-Agent': mbUserAgent(this.contact()), Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
        })
      } catch (e) {
        if (signal?.aborted) throw e
        throw new MbError('MusicBrainz non raggiungibile')
      }
      // troppe richieste o servizio occupato: si aspetta e si riprova
      if ((r.status === 503 || r.status === 429) && attempt < 3) {
        await sleepOrAbort(this.sleep, 5000 * (attempt + 1), signal)
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
    return this.recording(best.id, signal)
  }

  /** Lettura diretta di una registrazione già trovata (per esempio per aggiungere i generi). */
  async recording(id: string, signal?: AbortSignal): Promise<MbResult | null> {
    const rec = await this.get<Recording | null>(lookupUrl(id), signal)
    return rec ? parseRecording(rec) : null
  }

  /** Generi di un artista. */
  async artistGenres(id: string, signal?: AbortSignal): Promise<string[]> {
    const a = await this.get<{ genres?: Genre[] } | null>(artistUrl(id), signal)
    return topGenres(a?.genres)
  }
}
