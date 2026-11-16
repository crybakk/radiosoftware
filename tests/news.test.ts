import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NewsFetcher, parseFeed, validateSource, type NewsSource } from '../src/core/news'
import { expandEvent, EXTERNAL_TIMEOUT_MS, newsTrack } from '../src/core/eventActions'
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
    // voce sintetica al posto del notiziario
    const voce = await f.forAir(src({ ifMissing: 'voce', fallbackText: 'Il notiziario non è disponibile.' }))
    expect(voce).toMatchObject({ item: null, speak: 'Il notiziario non è disponibile.', fresh: false })
    expect(() => validateSource({ name: 'GR', url: 'https://x.it', ifMissing: 'voce' })).toThrow(/testo/)
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

describe('notiziari: feed e file ostili o rotti', () => {
  it('feed malformato enorme: si legge in fretta senza bloccare', () => {
    const t0 = Date.now()
    expect(parseFeed('<item <enclosure url="'.repeat(200_000))).toBeNull()
    expect(parseFeed('<item>' + '<title'.repeat(100_000) + '</item>')).toBeNull()
    expect(parseFeed('</item'.repeat(200_000))).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('link della puntata relativo al feed; link non http rifiutato', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    const s = server()
    s.routes.set('https://x.it/feed.xml', () => new Response(rss([{ url: '/audio/gr.mp3', title: 'GR', date: 'Sun, 15 Nov 2026 20:00:00 GMT' }])))
    s.routes.set('https://x.it/audio/gr.mp3', audio())
    const f = new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW })
    expect((await f.forAir(src())).fresh).toBe(true)
    s.routes.set('https://x.it/feed.xml', () => new Response(rss([{ url: 'file:///etc/passwd', title: 'GR', date: 'Sun, 15 Nov 2026 20:01:00 GMT' }])))
    expect((await f.forAir(src())).note).toMatch(/link della puntata non è valido/)
  })

  it('una pagina web al posto dell\'audio non si scarica né va in onda', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    const s = server()
    s.routes.set('https://x.it/feed.xml', () => new Response(rss([{ url: 'https://x.it/gr.mp3', title: 'GR', date: 'Sun, 15 Nov 2026 20:00:00 GMT' }])))
    s.routes.set('https://x.it/gr.mp3', () => new Response('<html>accedi</html>', { headers: { 'content-type': 'text/html' } }))
    const f = new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW })
    expect((await f.forAir(src())).note).toMatch(/non dà un file audio/)
    // link diretto che risponde con una pagina: niente file audio finto
    s.routes.set('https://x.it/diretto.mp3', () => new Response('<html>errore</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    const d = await f.forAir(src({ url: 'https://x.it/diretto.mp3' }))
    expect(d.item).toBeNull()
    expect(readdirSync(dir).filter((x) => x.endsWith('.mp3'))).toEqual([])
  })

  it('file senza lunghezza che supera il limite: si ferma e non resta niente su disco', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += 1024 * 1024
        c.enqueue(new Uint8Array(1024 * 1024))
      }
    })
    const s = server()
    s.routes.set('https://x.it/senza-fine.mp3', () => new Response(endless, { headers: { 'content-type': 'audio/mpeg' } }))
    const r = await new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW }).forAir(src({ url: 'https://x.it/senza-fine.mp3' }))
    expect(r.note).toMatch(/troppo grande/)
    expect(sent).toBeLessThan(260 * 1024 * 1024)
    expect(readdirSync(dir)).toEqual([])
  })

  it('feed troppo grande rifiutato', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    const s = server()
    s.routes.set('https://x.it/feed.xml', () => new Response('<rss>' + ' '.repeat(6 * 1024 * 1024), { headers: { 'content-type': 'application/rss+xml' } }))
    expect((await new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW }).forAir(src())).note).toMatch(/feed troppo grande/)
  })

  it('non cancella i notiziari di un\'altra fonte con il nome simile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    const s = server()
    s.routes.set('https://x.it/a.mp3', audio())
    s.routes.set('https://x.it/b.mp3', audio())
    const f = new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW })
    const other = await f.forAir(src({ id: 'gr-sera', url: 'https://x.it/b.mp3' }))
    await f.forAir(src({ id: 'gr', url: 'https://x.it/a.mp3' }))
    expect(existsSync(other.item!.file)).toBe(true)
  })

  it('due richieste insieme per la stessa fonte: un solo scaricamento', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    const s = server()
    s.routes.set('https://x.it/feed.xml', () => new Response(rss([{ url: 'https://x.it/gr.mp3', title: 'GR', date: 'Sun, 15 Nov 2026 20:00:00 GMT' }])))
    s.routes.set('https://x.it/gr.mp3', audio())
    const f = new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW })
    const [a, b] = await Promise.all([f.forAir(src()), f.forAir(src())])
    expect(a.item?.file).toBe(b.item?.file)
    expect(existsSync(a.item!.file)).toBe(true)
    expect(s.calls.filter((c) => c.url.endsWith('.mp3'))).toHaveLength(1)
  })
})

describe('notiziario e annuncio troppo lenti', () => {
  it('dopo il tempo massimo l\'evento va avanti con un errore', async () => {
    vi.useFakeTimers()
    try {
      const e = (actions: unknown[]): ScheduledEvent => ({ id: 1, label: 'GR', time: '*:00', days: [0], repeatMinutes: 0, untilTime: null, validFrom: null, validTo: null, mode: 'soft', toleranceSeconds: 0, actions, enabled: true }) as ScheduledEvent
      const fx = {
        now: () => new Date(NOW),
        runCommand: () => {},
        news: () => new Promise<never>(() => {}),
        voice: () => new Promise<never>(() => {})
      }
      const p = expandEvent({} as never, e([{ type: 'news', sourceId: 'gr', title: 'GR' }, { type: 'voice', text: 'Ciao' }]), fx)
      await vi.advanceTimersByTimeAsync(EXTERNAL_TIMEOUT_MS + 10)
      await vi.advanceTimersByTimeAsync(EXTERNAL_TIMEOUT_MS + 10)
      const steps = await p
      expect(steps).toEqual([
        { kind: 'error', message: expect.stringMatching(/notiziario "GR": scaricamento troppo lento/) },
        { kind: 'error', message: expect.stringMatching(/annuncio vocale: preparazione troppo lenta/) }
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('notiziario con il link della puntata sempre uguale', () => {
  it('se la data nel feed è più nuova si riscarica (e non se il file non è cambiato)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'))
    const s = server()
    const feedAt = (date: string) => () => new Response(rss([{ url: 'https://x.it/ultimo.mp3', title: 'GR', date }]))
    s.routes.set('https://x.it/feed.xml', feedAt('Sun, 15 Nov 2026 18:00:00 GMT'))
    s.routes.set('https://x.it/ultimo.mp3', audio({ etag: '"v1"' }))
    const f = new NewsFetcher(dir, { fetch: s.fetch, now: () => NOW })
    const first = await f.forAir(src())
    expect(first.note).toMatch(/vecchio/) // 18:00, limite 90 minuti

    // nuova edizione allo stesso link
    s.routes.set('https://x.it/feed.xml', feedAt('Sun, 15 Nov 2026 20:00:00 GMT'))
    s.routes.set('https://x.it/ultimo.mp3', () => new Response(new Uint8Array([9, 9, 9, 9]), { headers: { 'content-type': 'audio/mpeg', etag: '"v2"' } }))
    const second = await f.forAir(src())
    expect(second.fresh).toBe(true)
    expect(readFileSync(second.item!.file)).toEqual(Buffer.from([9, 9, 9, 9]))
    const audioCalls = s.calls.filter((c) => c.url.endsWith('.mp3'))
    expect(audioCalls).toHaveLength(2)
    expect(audioCalls[1].headers['If-None-Match']).toBe('"v1"')

    // data più nuova ma file uguale (304): niente scaricamento, e resta la data vera del file
    s.routes.set('https://x.it/feed.xml', feedAt('Sun, 15 Nov 2026 22:00:00 GMT'))
    s.routes.set('https://x.it/ultimo.mp3', () => new Response(null, { status: 304 }))
    const third = await f.forAir(src())
    expect(third.item?.file).toBe(second.item?.file)
    expect(third.item?.publishedAt).toBe(Date.parse('2026-11-15T20:00:00Z'))
  })
})
