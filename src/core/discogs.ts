/**
 * Generi e stili da Discogs (https://www.discogs.com/developers): ricerca della pubblicazione per interprete
 * e titolo del brano. Serve un token personale gratuito (impostazioni del profilo Discogs → Developers).
 * Discogs concede 60 richieste al minuto con il token.
 */
import { simplify } from './musicbrainz'
import { cleanTags, Throttled, type Fetch } from './webLimit'

const BASE = 'https://api.discogs.com'

interface SearchResult {
  title?: string
  genre?: string[]
  style?: string[]
}

export function discogsSearchUrl(artist: string, title: string): string {
  return `${BASE}/database/search?${new URLSearchParams({ type: 'release', artist, track: title, per_page: '5' })}`
}

/** Il primo risultato dello stesso interprete ("Interprete - Album"); generi prima, poi stili. */
export function pickDiscogs(results: SearchResult[], artist: string): string[] | null {
  const a = simplify(artist)
  for (const r of results) {
    const who = simplify((r.title ?? '').split(' - ')[0] ?? '')
    if (!a || !(who === a || who.startsWith(`${a} `) || a.startsWith(`${who} `))) continue
    return cleanTags([...(r.genre ?? []), ...(r.style ?? [])], 8)
  }
  return null
}

export class Discogs {
  private readonly http: Throttled

  constructor(
    private readonly token: () => string,
    opts: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
  ) {
    this.http = new Throttled('Discogs', 1100, opts)
  }

  /** null = nessuna pubblicazione sicura. */
  async genres(t: { artist: string; title: string }, signal?: AbortSignal): Promise<string[] | null> {
    if (!t.artist.trim() || !t.title.trim()) return null
    const r = await this.http.json<{ results?: SearchResult[] }>(discogsSearchUrl(t.artist, t.title), { Authorization: `Discogs token=${this.token()}` }, signal)
    return pickDiscogs(r?.results ?? [], t.artist)
  }
}
