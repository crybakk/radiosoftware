/**
 * Notiziari scaricati in automatico (usato sia dalla regia sia dal server).
 *
 * Una fonte è il feed di un podcast (si prende l'ultima puntata) oppure il link diretto a un file audio.
 * Si scarica solo al momento di andare in onda e solo se è cambiato rispetto all'ultima volta
 * (stesso link nel feed, oppure risposta 304 per il link diretto), per consumare pochi dati.
 * Se il notiziario è più vecchio del limite o non si scarica, si fa quello che dice la fonte:
 * saltarlo, mandare l'ultimo scaricato anche se vecchio, oppure un file scelto.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type NewsFallback = 'salta' | 'vecchio' | 'file' | 'voce'

export interface NewsSource {
  id: string
  name: string
  /** Feed RSS/Atom di un podcast oppure link diretto a un file audio. */
  url: string
  /** Oltre questa età (minuti) il notiziario è considerato vecchio. 0 = nessun limite. */
  maxAgeMinutes: number
  /** Cosa fare se è vecchio o non si scarica. */
  ifMissing: NewsFallback
  /** File da mandare con ifMissing = 'file' (percorso sul PC della regia, o file caricato sul server). */
  fallbackFile: string
  /** Testo da dire con la voce sintetica con ifMissing = 'voce'. */
  fallbackText?: string
}

export const NEWS_FALLBACKS: { value: NewsFallback; label: string }[] = [
  { value: 'salta', label: 'Saltalo' },
  { value: 'vecchio', label: "Manda l'ultimo scaricato" },
  { value: 'file', label: 'Manda un file a scelta' },
  { value: 'voce', label: 'Leggi un testo con la voce sintetica' }
]

export interface NewsItem {
  file: string
  /** Titolo della puntata (dal feed) o nome del file. */
  title: string
  publishedAt: number
  /** Secondi (0 = sconosciuto). */
  duration: number
}

interface Cache extends NewsItem {
  /** Link del file audio scaricato. */
  url: string
  etag: string
  lastModified: string
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i
const MAX_BYTES = 200 * 1024 * 1024

const decode = (s: string): string =>
  s
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()

/** Ultima puntata di un feed RSS o Atom: link del file audio, titolo e data. */
export function parseFeed(xml: string): { url: string; title: string; publishedAt: number } | null {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0])
  const items = blocks
    .map((b) => {
      const enc =
        /<enclosure\b[^>]*\burl\s*=\s*["']([^"']+)["']/i.exec(b)?.[1] ??
        /<link\b[^>]*\brel\s*=\s*["']enclosure["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(b)?.[1] ??
        /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']enclosure["']/i.exec(b)?.[1] ??
        /<media:content\b[^>]*\burl\s*=\s*["']([^"']+)["']/i.exec(b)?.[1]
      if (!enc) return null
      const title = decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(b)?.[1] ?? '')
      const date = /<(pubDate|published|updated|dc:date)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(b)?.[2]
      const t = date ? Date.parse(decode(date)) : NaN
      return { url: decode(enc), title, publishedAt: Number.isFinite(t) ? t : 0 }
    })
    .filter((x): x is { url: string; title: string; publishedAt: number } => !!x)
  if (!items.length) return null
  // di solito il primo è il più recente, ma non sempre: si sceglie per data
  return items.reduce((a, b) => (b.publishedAt > a.publishedAt ? b : a))
}

/** Controlla che una fonte sia sensata (per i moduli di regia e pannello). */
export function validateSource(s: Partial<NewsSource>): NewsSource {
  const name = String(s.name ?? '').trim()
  const url = String(s.url ?? '').trim()
  if (!name) throw new Error('manca il nome della fonte')
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('il link deve cominciare con http:// o https://')
  const ifMissing = NEWS_FALLBACKS.some((f) => f.value === s.ifMissing) ? (s.ifMissing as NewsFallback) : 'salta'
  const fallbackFile = String(s.fallbackFile ?? '').trim()
  if (ifMissing === 'file' && !fallbackFile) throw new Error('scegli il file da mandare quando il notiziario manca')
  const fallbackText = String(s.fallbackText ?? '').trim()
  if (ifMissing === 'voce' && !fallbackText) throw new Error('scrivi il testo da leggere quando il notiziario manca')
  return {
    id: String(s.id ?? '').trim() || `n${Date.now().toString(36)}`,
    name: name.slice(0, 100),
    url,
    maxAgeMinutes: Math.max(0, Math.min(10_080, Math.round(Number(s.maxAgeMinutes) || 0))),
    ifMissing,
    fallbackFile,
    fallbackText
  }
}

async function duration(file: string): Promise<number> {
  try {
    const { parseFile } = await import('music-metadata')
    return Math.round((await parseFile(file, { duration: true })).format.duration ?? 0)
  } catch {
    return 0
  }
}

export interface NewsResult {
  /** Il notiziario da mandare in onda (null = niente). */
  item: NewsItem | null
  /** Testo da leggere con la voce sintetica al suo posto (ifMissing = 'voce'). */
  speak?: string
  /** Spiegazione per il registro, gli avvisi e il pulsante "Prova". */
  note: string
  /** true se è il notiziario aggiornato (non un ripiego). */
  fresh: boolean
}

/** Scarica (se serve) le ultime notizie di una fonte nella cartella `dir`. */
export class NewsFetcher {
  private readonly dir: string
  private readonly fetch: Fetch
  private readonly now: () => number

  constructor(dir: string, opts: { fetch?: Fetch; now?: () => number } = {}) {
    this.dir = dir
    this.fetch = opts.fetch ?? fetch
    this.now = opts.now ?? (() => Date.now())
  }

  private cacheFile(id: string): string {
    return join(this.dir, `${id.replace(/[^\w-]/g, '_')}.json`)
  }

  /** Ultimo notiziario scaricato per la fonte (se il file c'è ancora). */
  cached(id: string): Cache | null {
    try {
      const c = JSON.parse(readFileSync(this.cacheFile(id), 'utf8')) as Cache
      return existsSync(c.file) ? c : null
    } catch {
      return null
    }
  }

  /** Scarica il file audio e tiene solo quello (gli scaricati prima della stessa fonte si cancellano). */
  private async download(src: NewsSource, res: Response, url: string): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_BYTES) throw new Error('file troppo grande')
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('file vuoto')
    if (buf.length > MAX_BYTES) throw new Error('file troppo grande')
    const ext = (AUDIO_EXT.exec(new URL(url).pathname)?.[0] ?? (/mp4|m4a|aac/i.test(res.headers.get('content-type') ?? '') ? '.m4a' : '.mp3')).toLowerCase()
    const prefix = `${src.id.replace(/[^\w-]/g, '_')}-`
    const name = `${prefix}${createHash('sha1').update(url).update(String(this.now())).digest('hex').slice(0, 10)}${ext}`
    const file = join(this.dir, name)
    await writeFile(`${file}.tmp`, buf)
    await rename(`${file}.tmp`, file)
    for (const f of await readdir(this.dir)) {
      if (f.startsWith(prefix) && f !== name && !f.endsWith('.json')) await rm(join(this.dir, f), { force: true })
    }
    return file
  }

  private async save(id: string, c: Cache): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(`${this.cacheFile(id)}.tmp`, JSON.stringify(c))
    await rename(`${this.cacheFile(id)}.tmp`, this.cacheFile(id))
  }

  /** Ultima edizione: scarica solo se è cambiata. Errore se non si riesce. */
  async latest(src: NewsSource): Promise<NewsItem> {
    const c = this.cached(src.id)
    const signal = AbortSignal.timeout(90_000)
    const direct = AUDIO_EXT.test(new URL(src.url).pathname)
    const headers: Record<string, string> = { 'User-Agent': 'RadioRegia/1.0 (notiziari)' }
    if (c && c.url === src.url) {
      if (c.etag) headers['If-None-Match'] = c.etag
      if (c.lastModified) headers['If-Modified-Since'] = c.lastModified
    }
    const r = await this.fetch(src.url, { headers, signal, redirect: 'follow' })
    if (r.status === 304 && c) return c
    if (!r.ok) throw new Error(`il link risponde ${r.status}`)
    const type = r.headers.get('content-type') ?? ''
    if (direct || /^audio\//i.test(type) || /octet-stream/i.test(type)) {
      // link diretto al file: la data è quella del file sul server (se la dice)
      const lm = r.headers.get('last-modified') ?? ''
      const file = await this.download(src, r, src.url)
      const item: Cache = {
        file,
        title: src.name,
        publishedAt: lm && Number.isFinite(Date.parse(lm)) ? Date.parse(lm) : this.now(),
        duration: await duration(file),
        url: src.url,
        etag: r.headers.get('etag') ?? '',
        lastModified: lm
      }
      await this.save(src.id, item)
      return item
    }
    const feed = parseFeed(await r.text())
    if (!feed) throw new Error('nel feed non c\'è nessun file audio')
    if (c && c.url === feed.url) {
      // stessa puntata di prima: niente download
      if (feed.publishedAt && feed.publishedAt !== c.publishedAt) {
        c.publishedAt = feed.publishedAt
        await this.save(src.id, c)
      }
      return c
    }
    const a = await this.fetch(feed.url, { headers: { 'User-Agent': headers['User-Agent'] }, signal, redirect: 'follow' })
    if (!a.ok) throw new Error(`il file audio risponde ${a.status}`)
    const file = await this.download(src, a, feed.url)
    const item: Cache = {
      file,
      title: feed.title || src.name,
      publishedAt: feed.publishedAt || this.now(),
      duration: await duration(file),
      url: feed.url,
      etag: '',
      lastModified: ''
    }
    await this.save(src.id, item)
    return item
  }

  /** Cosa mandare in onda adesso per questa fonte, applicando età massima e ripiego. */
  async forAir(src: NewsSource, fallbackDuration?: (file: string) => Promise<number>): Promise<NewsResult> {
    let item: NewsItem | null = null
    let why = ''
    try {
      item = await this.latest(src)
      const age = this.now() - item.publishedAt
      if (src.maxAgeMinutes > 0 && age > src.maxAgeMinutes * 60_000) {
        why = `è vecchio (${Math.round(age / 60_000)} minuti)`
      } else {
        return { item, note: `${src.name}: ${item.title}`, fresh: true }
      }
    } catch (e) {
      why = `non scaricato (${e instanceof Error ? e.message : String(e)})`
      item = this.cached(src.id)
    }
    if (src.ifMissing === 'vecchio' && item) return { item, note: `${src.name} ${why}: mando l'ultimo scaricato`, fresh: false }
    if (src.ifMissing === 'file' && src.fallbackFile && existsSync(src.fallbackFile)) {
      const d = fallbackDuration ? await fallbackDuration(src.fallbackFile) : await duration(src.fallbackFile)
      return { item: { file: src.fallbackFile, title: src.name, publishedAt: 0, duration: d }, note: `${src.name} ${why}: mando il file scelto`, fresh: false }
    }
    if (src.ifMissing === 'voce' && src.fallbackText?.trim()) {
      return { item: null, speak: src.fallbackText.trim(), note: `${src.name} ${why}: leggo il testo con la voce sintetica`, fresh: false }
    }
    if (src.ifMissing === 'file') return { item: null, note: `${src.name} ${why}, e il file da mandare al suo posto non c'è`, fresh: false }
    return { item: null, note: `${src.name} ${why}: saltato`, fresh: false }
  }
}
