/**
 * Etichette da Last.fm (https://www.last.fm/api): quelle più usate dagli ascoltatori per il brano, oppure per
 * l'artista se il brano non ne ha. Dicono anche il "carattere" (chill, allegro, anni 80). Serve una chiave API
 * gratuita (https://www.last.fm/api/account/create). Last.fm chiede al massimo 5 richieste al secondo.
 */
import { simplify } from './musicbrainz'
import { cleanTags, ServiceError, Throttled, type Fetch } from './webLimit'

const BASE = 'https://ws.audioscrobbler.com/2.0/'
/** Peso minimo dell'etichetta (Last.fm dà 100 alla più usata). */
const MIN_COUNT = 10
const MAX_TAGS = 6
/** Etichette personali o inutili per una rotazione. */
const JUNK = new Set([
  'seen live', 'favorites', 'favourites', 'favorite', 'favourite', 'my favorite', 'my favourites', 'love', 'loved',
  'awesome', 'beautiful', 'cool', 'good', 'great', 'best', 'amazing', 'spotify', 'youtube', 'albums i own', 'under 2000 listeners'
])

interface Tag {
  name?: string
  count?: number | string
}

export function lastfmUrl(method: 'track.gettoptags' | 'artist.gettoptags', key: string, artist: string, title?: string): string {
  const p: Record<string, string> = { method, artist, autocorrect: '1', api_key: key, format: 'json' }
  if (title) p.track = title
  return `${BASE}?${new URLSearchParams(p)}`
}

export function pickTags(tags: Tag[] | undefined, artist: string): string[] {
  const a = simplify(artist)
  const ok = (tags ?? []).filter((t) => Number(t.count ?? 0) >= MIN_COUNT).map((t) => t.name ?? '')
  return cleanTags(ok, MAX_TAGS, (t) => JUNK.has(t) || simplify(t) === a)
}

export class LastFm {
  private readonly http: Throttled

  constructor(
    private readonly key: () => string,
    opts: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
  ) {
    this.http = new Throttled('Last.fm', 250, opts)
  }

  private async tags(url: string, artist: string, signal?: AbortSignal): Promise<string[]> {
    const r = await this.http.json<{ toptags?: { tag?: Tag[] | Tag }; error?: number; message?: string }>(url, {}, signal)
    // Last.fm risponde 200 con un codice di errore: 6 = brano o artista non trovato, 10/26 = chiave sbagliata
    if (r?.error === 10 || r?.error === 26) throw new ServiceError('Last.fm: chiave non valida')
    if (r?.error && r.error !== 6) throw new ServiceError(`Last.fm: ${r.message ?? `errore ${r.error}`}`)
    const t = r?.toptags?.tag
    return pickTags(Array.isArray(t) ? t : t ? [t] : [], artist)
  }

  trackTags(t: { artist: string; title: string }, signal?: AbortSignal): Promise<string[]> {
    return this.tags(lastfmUrl('track.gettoptags', this.key(), t.artist, t.title), t.artist, signal)
  }

  artistTags(artist: string, signal?: AbortSignal): Promise<string[]> {
    return this.tags(lastfmUrl('artist.gettoptags', this.key(), artist), artist, signal)
  }
}
