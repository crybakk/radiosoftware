import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NewsFetcher, parseFeed, validateSource, type NewsSource } from '../src/core/news'
import { expandEvent, newsTrack } from '../src/core/eventActions'
import type { ScheduledEvent } from '../src/core/types'

const NOW = Date.parse('2026-11-15T20:05:00Z')

const rss = (items: { url: string; title: string; date: string }[]): string =>
  `<?xml version="1.0"?><rss><channel><title>GR</title>${items
    .map((i) => `<item><title><![CDATA[${i.title}]]></title><pubDate>${i.date}</pubDate><enclosure url="${i.url}" type="audio/mpeg" length="1"/></item>`)
    .join('')}</channel></rss>`

describe('feed dei notiziari', () => {
  it('prende la puntata più recente di un RSS', () => {
    const f = parseFeed(
      rss([
        { url: 'https://x.it/a.mp3', title: 'GR delle 19', date: 'Sun, 15 Nov 2026 18:00:00 GMT' },
        { url: 'https://x.it/b.mp3?x=1&amp;y=2', title: 'GR delle 20 &amp; meteo', date: 'Sun, 15 Nov 2026 19:00:00 GMT' }
      ])
    )
    expect(f).toEqual({ url: 'https://x.it/b.mp3?x=1&y=2', title: 'GR delle 20 & meteo', publishedAt: Date.parse('2026-11-15T19:00:00Z') })
  })

  it('legge anche Atom e scarta le voci senza audio', () => {
    const xml = `<feed><entry><title>Testo</title><updated>2026-11-15T19:30:00Z</updated></entry>
      <entry><title>Ultimo</title><updated>2026-11-15T19:00:00Z</updated><link rel="enclosure" href="https://x.it/c.mp3"/></entry></feed>`
    expect(parseFeed(xml)?.url).toBe('https://x.it/c.mp3')
    expect(parseFeed('<rss><channel></channel></rss>')).toBeNull()
  })

  it('controlla le fonti', () => {
    expect(() => validateSource({ name: '', url: 'https://x.it' })).toThrow(/nome/)
    expect(() => validateSource({ name: 'GR', url: 'ftp://x' })).toThrow(/http/)
    expect(() => validateSource({ name: 'GR', url: 'https://x.it', ifMissing: 'file' })).toThrow(/file/)
    expect(validateSource({ name: 'GR', url: 'https://x.it/f.xml', maxAgeMinutes: -5 }).maxAgeMinutes).toBe(0)
  })
})

function server() {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const routes = new Map<string, () => Response>()
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const r = routes.get(url)
    if (!r) throw new Error('rete giù')
    return r()
  }
  return { calls, routes, fetch }
}

const src = (over: Partial<NewsSource> = {}): NewsSource => ({
  id: 'gr',
  name: 'GR',
  url: 'https://x.it/feed.xml',
  maxAgeMinutes: 90,
  ifMissing: 'salta',
  fallbackFile: '',
  ...over
})
const audio = (headers: Record<string, string> = {}) => () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg', ...headers } })

describe('download dei notiziari', () => {
  it('scarica l\'ultima puntata del feed e non la riscarica se è la stessa', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    const s = server()
    s.routes.set('https://x.it/feed.xml', () => new Response(rss([{ url: 'https://x.it/gr20.mp3', title: 'GR delle 20', date: 'Sun, 15 Nov 2026 19:00:00 GMT' }])))
    s.routes.set('https://x.it/gr20.mp3', audio())
    const f = new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW })
    const r = await f.forAir(src())
    expect(r.fresh).toBe(true)
    expect(r.item?.title).toBe('GR delle 20')
    expect(existsSync(r.item!.file)).toBe(true)
    await f.forAir(src())
    expect(s.calls.filter((c) => c.url.endsWith('.mp3'))).toHaveLength(1)

    // nuova edizione: si scarica e la vecchia si cancella
    s.routes.set('https://x.it/feed.xml', () => new Response(rss([{ url: 'https://x.it/gr21.mp3', title: 'GR delle 21', date: 'Sun, 15 Nov 2026 20:00:00 GMT' }])))
    s.routes.set('https://x.it/gr21.mp3', audio())
    const r2 = await new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW }).forAir(src())
    expect(r2.item?.title).toBe('GR delle 21')
    expect(readdirSync(dir).filter((x) => x.endsWith('.mp3'))).toEqual([r2.item!.file.split(/[\\/]/).at(-1)])
  })

  it('link diretto: chiede solo se è cambiato (304)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    const s = server()
    const url = 'https://x.it/ultimo.mp3'
    s.routes.set(url, audio({ etag: '"v1"', 'last-modified': 'Sun, 15 Nov 2026 19:55:00 GMT' }))
    const f = new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW })
    const r = await f.forAir(src({ url }))
    expect(r.item?.publishedAt).toBe(Date.parse('2026-11-15T19:55:00Z'))
    s.routes.set(url, () => new Response(null, { status: 304 }))
    const r2 = await f.forAir(src({ url }))
    expect(s.calls.at(-1)!.headers['If-None-Match']).toBe('"v1"')
    expect(r2.item?.file).toBe(r.item?.file)
  })

  it('notiziario vecchio o non scaricato: salta, ultimo scaricato o file scelto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    const s = server()
    s.routes.set('https://x.it/feed.xml', () => new Response(rss([{ url: 'https://x.it/gr.mp3', title: 'GR di ieri', date: 'Sat, 14 Nov 2026 19:00:00 GMT' }])))
    s.routes.set('https://x.it/gr.mp3', audio())
    const f = new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW })
    const skip = await f.forAir(src())
    expect(skip.item).toBeNull()
    expect(skip.note).toMatch(/vecchio .*saltato/)
    expect((await f.forAir(src({ ifMissing: 'vecchio' }))).item?.title).toBe('GR di ieri')
    expect((await f.forAir(src({ maxAgeMinutes: 0 }))).fresh).toBe(true)

    const spare = join(dir, 'riserva.mp3')
    writeFileSync(spare, Buffer.from([1]))
    const viaFile = await f.forAir(src({ ifMissing: 'file', fallbackFile: spare }), async () => 42)
    expect(viaFile.item).toEqual({ file: spare, title: 'GR', publishedAt: 0, duration: 42 })

    // rete giù: con "vecchio" va l'ultimo scaricato
    s.routes.clear()
    const down = await f.forAir(src({ ifMissing: 'vecchio' }))
    expect(down.item?.title).toBe('GR di ieri')
    expect(down.note).toMatch(/non scaricato \(rete giù\)/)
    expect((await f.forAir(src())).item).toBeNull()
  })
})

describe('azione Notiziario negli eventi', () => {
  const ev = (sourceId: string): ScheduledEvent => ({
    id: 1,
    label: 'GR',
    time: '*:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    repeatMinutes: 0,
    untilTime: null,
    validFrom: null,
    validTo: null,
    mode: 'soft',
    toleranceSeconds: 0,
    actions: [{ type: 'news', sourceId, title: 'GR' }],
    enabled: true
  }) as ScheduledEvent

  it('mette in testa il notiziario, o segnala perché manca', async () => {
    const track = newsTrack('GR', { file: '/tmp/gr.mp3', title: 'GR delle 20', duration: 240, publishedAt: NOW })
    expect(track).toMatchObject({ kind: 'news', title: 'GR delle 20', artist: 'GR', duration: 240, path: '/tmp/gr.mp3' })
    expect(track.id).toBeLessThan(0)
    const fx = {
      now: () => new Date(NOW),
      runCommand: () => {},
      news: async (id: string) => (id === 'gr' ? { track, note: '' } : { track: null, note: 'è vecchio: saltato' })
    }
    expect(await expandEvent({} as never, ev('gr'), fx)).toEqual([{ kind: 'tracks', tracks: [track], placement: 'front' }])
    expect(await expandEvent({} as never, ev('x'), fx)).toEqual([{ kind: 'error', message: 'notiziario "GR": è vecchio: saltato' }])
  })
})
