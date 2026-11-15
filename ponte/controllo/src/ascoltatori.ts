/**
 * Statistiche degli ascoltatori (scelte di cristian, 15/11/2026): ogni minuto si leggono gli ascoltatori
 * dell'Icecast principale e di quello secondario; lo storico resta un anno. Dal pannello e dalla regia si
 * vedono gli ascoltatori adesso, il grafico del giorno o della settimana, picco e media per ora del giorno
 * e per programma, e le ore totali di ascolto.
 *
 * Icecast secondario: si prova la pagina pubblica status-json.xsl; se ci sono le credenziali di
 * amministrazione si usa /admin/stats (XML), che funziona anche quando la pagina pubblica è chiusa.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { activeSlot, type Program } from './programmi.ts'

export interface Sample {
  /** Minuto (ms, arrotondato). */
  t: number
  /** Icecast principale. */
  a: number
  /** Icecast secondario (null = non letto). */
  b: number | null
}

const KEEP_DAYS = 366
const MIN = 60_000

const dayKey = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Un file per giorno (ora locale), una riga per minuto. */
export class ListenerLog {
  private readonly dir: string
  private last: Sample | null = null

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  add(s: Sample): void {
    const t = Math.floor(s.t / MIN) * MIN
    if (this.last && this.last.t === t) return
    this.last = { ...s, t }
    appendFileSync(join(this.dir, `${dayKey(t)}.jsonl`), `${JSON.stringify(this.last)}\n`)
  }

  latest(): Sample | null {
    return this.last
  }

  /** Campioni con t in [from, to). */
  read(from: number, to: number): Sample[] {
    const out: Sample[] = []
    for (let d = new Date(new Date(from).setHours(0, 0, 0, 0)); d.getTime() < to; d.setDate(d.getDate() + 1)) {
      const f = join(this.dir, `${dayKey(d.getTime())}.jsonl`)
      if (!existsSync(f)) continue
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const s = JSON.parse(line) as Sample
          if (s.t >= from && s.t < to) out.push(s)
        } catch {
          // riga rovinata: si salta
        }
      }
    }
    return out
  }

  /** Toglie i giorni più vecchi di un anno. */
  prune(now = Date.now()): void {
    const limit = dayKey(now - KEEP_DAYS * 86_400_000)
    for (const f of readdirSync(this.dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < limit) rmSync(join(this.dir, f), { force: true })
    }
  }
}

// ---------- lettura degli Icecast ----------

/** Ascoltatori di un mount dal JSON pubblico di Icecast; null se il mount non c'è. */
export function fromStatusJson(status: unknown, mount: string): number | null {
  const src = (status as { icestats?: { source?: unknown } })?.icestats?.source
  const list = (Array.isArray(src) ? src : src ? [src] : []) as { listenurl?: string; listeners?: number }[]
  const m = list.find((x) => {
    try {
      return typeof x.listenurl === 'string' && new URL(x.listenurl, 'http://x').pathname === mount
    } catch {
      return false
    }
  })
  return m ? Number(m.listeners) || 0 : null
}

/** Ascoltatori di un mount dall'XML di /admin/stats; null se il mount non c'è. */
export function fromAdminXml(xml: string, mount: string): number | null {
  const esc = mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`<source mount="${esc}">([\\s\\S]*?)</source>`).exec(xml)
  if (!m) return null
  const l = /<listeners>(\d+)<\/listeners>/.exec(m[1])
  return l ? Number(l[1]) : 0
}

export interface SecondaryConfig {
  host: string
  port: number
  mount: string
  https?: boolean
  adminUser?: string
  adminPassword?: string
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** Ascoltatori dell'Icecast secondario: prima con le credenziali (se ci sono), poi la pagina pubblica. */
export async function readSecondary(c: SecondaryConfig, fetchFn: Fetch = fetch): Promise<number | null> {
  if (!c.host) return null
  const base = `${c.https ? 'https' : 'http'}://${c.host}:${c.port}`
  if (c.adminPassword) {
    const auth = Buffer.from(`${c.adminUser || 'admin'}:${c.adminPassword}`).toString('base64')
    const r = await fetchFn(`${base}/admin/stats`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(5000) }).catch(() => null)
    if (r?.ok) {
      const n = fromAdminXml(await r.text(), c.mount)
      if (n !== null) return n
    }
  }
  const r = await fetchFn(`${base}/status-json.xsl`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
  if (!r?.ok) return null
  const j = await r.json().catch(() => null)
  return j ? fromStatusJson(j, c.mount) : null
}

// ---------- calcoli ----------

export interface Point {
  t: number
  /** Media del totale nell'intervallo. */
  avg: number
  peak: number
  /** Medie dei due Icecast. */
  a: number
  b: number | null
}

export interface Report {
  from: number
  to: number
  /** Intervallo dei punti del grafico, in minuti. */
  step: number
  series: Point[]
  peak: number
  peakAt: number | null
  avg: number
  /** Ore totali di ascolto (ascoltatori × ore). */
  hours: number
  /** Ore del giorno 0-23. */
  byHour: { hour: number; avg: number; peak: number }[]
  byProgram: { id: string; title: string; avg: number; peak: number; hours: number; minutes: number }[]
}

const total = (s: Sample): number => s.a + (s.b ?? 0)
const round1 = (n: number): number => Math.round(n * 10) / 10

export function report(samples: Sample[], from: number, to: number, stepMin: number, programs: Pick<Program, 'id' | 'title' | 'slots'>[]): Report {
  const step = stepMin * MIN
  const buckets = new Map<number, Sample[]>()
  for (const s of samples) {
    const k = from + Math.floor((s.t - from) / step) * step
    const list = buckets.get(k) ?? []
    list.push(s)
    buckets.set(k, list)
  }
  const series: Point[] = []
  for (let t = from; t < to; t += step) {
    const list = buckets.get(t)
    if (!list) continue
    const withB = list.filter((s) => s.b !== null)
    series.push({
      t,
      avg: round1(list.reduce((n, s) => n + total(s), 0) / list.length),
      peak: Math.max(...list.map(total)),
      a: round1(list.reduce((n, s) => n + s.a, 0) / list.length),
      b: withB.length ? round1(withB.reduce((n, s) => n + (s.b ?? 0), 0) / withB.length) : null
    })
  }
  let peak = 0
  let peakAt: number | null = null
  let sum = 0
  const hours = Array.from({ length: 24 }, () => ({ sum: 0, n: 0, peak: 0 }))
  const progs = new Map<string, { sum: number; n: number; peak: number }>()
  for (const s of samples) {
    const v = total(s)
    sum += v
    if (v > peak || peakAt === null) {
      peak = v
      peakAt = s.t
    }
    const h = hours[new Date(s.t).getHours()]
    h.sum += v
    h.n++
    h.peak = Math.max(h.peak, v)
    for (const p of programs) {
      if (!activeSlot(p.slots, new Date(s.t))) continue
      const x = progs.get(p.id) ?? { sum: 0, n: 0, peak: 0 }
      x.sum += v
      x.n++
      x.peak = Math.max(x.peak, v)
      progs.set(p.id, x)
    }
  }
  return {
    from,
    to,
    step: stepMin,
    series,
    peak,
    peakAt: samples.length ? peakAt : null,
    avg: samples.length ? round1(sum / samples.length) : 0,
    hours: round1(sum / 60),
    byHour: hours.map((h, hour) => ({ hour, avg: h.n ? round1(h.sum / h.n) : 0, peak: h.peak })),
    byProgram: programs
      .filter((p) => progs.has(p.id))
      .map((p) => {
        const x = progs.get(p.id)!
        return { id: p.id, title: p.title, avg: round1(x.sum / x.n), peak: x.peak, hours: round1(x.sum / 60), minutes: x.n }
      })
      .sort((a, b) => b.hours - a.hours)
  }
}

/** Periodo: un giorno (punti ogni 10 minuti) o una settimana da lunedì (punti ogni ora). */
export function period(kind: 'giorno' | 'settimana', date: string): { from: number; to: number; step: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(new Date().setHours(0, 0, 0, 0))
  if (kind === 'settimana') {
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    const to = new Date(d)
    to.setDate(to.getDate() + 7)
    return { from: d.getTime(), to: to.getTime(), step: 60 }
  }
  const to = new Date(d)
  to.setDate(to.getDate() + 1)
  return { from: d.getTime(), to: to.getTime(), step: 10 }
}
