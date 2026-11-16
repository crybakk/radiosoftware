/**
 * Richieste a un servizio web con un intervallo minimo tra l'una e l'altra (i servizi gratuiti lo chiedono)
 * e qualche nuovo tentativo se il servizio è occupato. Il turno si prenota prima di aspettare, così due
 * richieste insieme non partono nello stesso istante.
 */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export class ServiceError extends Error {}

/** Attesa che si interrompe subito se si preme "Ferma" (altrimenti dopo un 503 si resta fermi fino a 15 secondi). */
export async function sleepOrAbort(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  signal.throwIfAborted()
  let off = (): void => {}
  const stopped = new Promise<never>((_, reject) => {
    const f = (): void => reject(signal.reason)
    signal.addEventListener('abort', f, { once: true })
    off = () => signal.removeEventListener('abort', f)
  })
  try {
    await Promise.race([sleep(ms), stopped])
  } finally {
    off()
  }
}

/** Attese tra i tentativi quando il servizio è occupato (503, 429, 502): circa 3 minuti in tutto. */
const BUSY_WAITS_S = [5, 10, 20, 40, 60, 60]

/** Quanto aspettare prima del prossimo tentativo (null = basta tentativi). Rispetta "Retry-After" se c'è. */
export function busyWait(r: Response, attempt: number): number | null {
  if (![429, 502, 503].includes(r.status) || attempt >= BUSY_WAITS_S.length) return null
  const after = Number(r.headers.get('retry-after'))
  const s = Number.isFinite(after) && after > 0 ? Math.min(120, after) : BUSY_WAITS_S[attempt]
  return s * 1000
}

/**
 * Pause della ricerca in background dopo errori di fila (rete o servizio in difficoltà): invece di fermarsi
 * aspetta e riprova da sola, sempre più a lungo; si ferma solo se va male per più di mezz'ora.
 * failures = errori di fila (1, 2, ...); null = fermati.
 */
export function pauseAfter(failures: number): number | null {
  if (failures < 3) return 0
  const waits = [1, 2, 5, 10, 10] // minuti, 28 in tutto
  const i = failures - 3
  return i < waits.length ? waits[i] * 60_000 : null
}

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

  /**
   * JSON della risposta; null se 404. errorJson: il servizio spiega l'errore nel JSON di una risposta 400
   * (AcoustID fa così anche per la chiave sbagliata), che allora si restituisce.
   */
  async json<T>(url: string, headers: Record<string, string>, signal?: AbortSignal, errorJson = false): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      const now = this.now()
      const at = Math.max(now, this.last + this.gapMs)
      this.last = at
      if (at > now) await sleepOrAbort(this.sleep, at - now, signal)
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
      const wait = busyWait(r, attempt)
      if (wait != null) {
        await sleepOrAbort(this.sleep, wait, signal)
        continue
      }
      if (r.status === 404) return null
      if (r.status === 400 && errorJson) {
        const body = (await r.json().catch(() => null)) as T | null
        if (body) return body
      }
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
