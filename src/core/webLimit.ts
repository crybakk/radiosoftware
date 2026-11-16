/**
 * Richieste a un servizio web con un intervallo minimo tra l'una e l'altra (i servizi gratuiti lo chiedono)
 * e qualche nuovo tentativo se il servizio è occupato. Il turno si prenota prima di aspettare, così due
 * richieste insieme non partono nello stesso istante.
 */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export class ServiceError extends Error {}

export class Throttled {
  private last = 0
  private readonly fetchFn: Fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(
    private readonly name: string,
    private readonly gapMs: number,
    opts: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
  ) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i))
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = opts.now ?? (() => Date.now())
  }

  /** JSON della risposta; null se 404. */
  async json<T>(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      const now = this.now()
      const at = Math.max(now, this.last + this.gapMs)
      this.last = at
      if (at > now) await this.sleep(at - now)
      let r: Response
      try {
        r = await this.fetchFn(url, {
          headers: { 'User-Agent': 'RadioRegia/0.1', Accept: 'application/json', ...headers },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
        })
      } catch (e) {
        if (signal?.aborted) throw e
        throw new ServiceError(`${this.name} non raggiungibile`)
      }
      if ((r.status === 429 || r.status === 503 || r.status === 502) && attempt < 3) {
        await this.sleep(5000 * (attempt + 1))
        continue
      }
      if (r.status === 404) return null
      if (r.status === 401 || r.status === 403) throw new ServiceError(`${this.name}: chiave non valida o non autorizzata`)
      if (!r.ok) throw new ServiceError(`${this.name} ha risposto con l'errore ${r.status}`)
      return (await r.json()) as T
    }
  }
}

/** Etichette pulite: minuscole, senza doppioni, al massimo n. */
export function cleanTags(list: string[], n: number, drop: (t: string) => boolean = () => false): string[] {
  const out: string[] = []
  for (const x of list) {
    const t = x.trim().toLowerCase().replace(/\s+/g, ' ')
    if (t && t.length <= 40 && !out.includes(t) && !drop(t)) out.push(t)
    if (out.length >= n) break
  }
  return out
}
