/** Dialogo con il servizio di controllo del ponte (HTTP + token). */

export interface PonteAlarm {
  key: string
  since: string
  message: string
}

export interface PonteBackup {
  name: string
  size: number
  date: string
}

export interface PonteState {
  studioConnected: boolean
  externalConnected?: boolean
  lastHeartbeat: string | null
  reconnectsLast10Min: number
  lastAzuracastError: string | null
  alarms: PonteAlarm[]
  liquidsoap: { studio?: boolean; esterna?: boolean } | null
  notifiche: string[]
}

export class PonteError extends Error {}

export interface PonteAddress {
  /** Solo il nome o l'IP del ponte (per SRT, che usa sempre la sua porta). */
  hostname: string
  /**
   * Indirizzo completo del servizio di controllo, se è stato scritto con http(s):// o ws(s)://
   * (es. https://ponte.esempio.it:8443): in quel caso vale la porta scritta lì.
   */
  base: string | null
  /** Porta scritta dopo il nome senza http(s):// (es. "radio.esempio.it:9080"): ambigua, non usata. */
  strayPort: number | null
}

/**
 * Unico punto in cui si interpreta l'indirizzo del ponte scritto nelle impostazioni:
 * toglie spazi e barre finali, accetta http(s):// e ws(s)://.
 */
export function parsePonteHost(input: string): PonteAddress {
  const h = input.trim().replace(/\/+$/, '')
  if (/^(https?|wss?):\/\//i.test(h)) {
    // ws:// → http://, wss:// → https://
    const http = h.replace(/^ws/i, 'http')
    try {
      const u = new URL(http)
      const path = u.pathname.replace(/\/+$/, '')
      return { hostname: u.hostname, base: `${u.protocol}//${u.host}${path}`, strayPort: null }
    } catch {
      return { hostname: h.replace(/^[a-z]+:\/\//i, '').split('/')[0], base: null, strayPort: null }
    }
  }
  const bare = h.split('/')[0]
  const m = /^([^:]+):(\d+)$/.exec(bare)
  if (m) return { hostname: m[1], base: null, strayPort: Number(m[2]) }
  return { hostname: bare, base: null, strayPort: null }
}

/** Problema nell'indirizzo del ponte da segnalare prima di salvare, oppure null. */
export function ponteHostProblem(input: string): string | null {
  const a = parsePonteHost(input)
  if (input.trim() && !a.hostname) return 'Indirizzo del server non valido'
  if (a.strayPort !== null)
    return 'Scrivi l\'indirizzo del server senza ":porta" (es. radio.esempio.it): le porte vanno nei campi «Porta SRT» e «Porta del servizio di controllo»'
  return null
}

/** Indirizzo http(s) del servizio di controllo (e del pannello). */
export function ponteControlBase(host: string, port: number, https: boolean): string {
  const a = parsePonteHost(host)
  return a.base ?? `${https ? 'https' : 'http'}://${a.hostname}:${port}`
}

export class PonteClient {
  private base: string
  private token: string

  constructor(host: string, port: number, token: string, https = false) {
    // si può scrivere anche l'indirizzo completo (https://ponte.esempio.it:8443)
    this.base = ponteControlBase(host, port, https)
    this.token = token
  }

  private async request(method: string, path: string, body?: BodyInit, type?: string, timeoutMs = 10_000): Promise<Response> {
    let r: Response
    try {
      r = await fetch(this.base + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(type ? { 'Content-Type': type } : {}) },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      const msg = e instanceof Error && e.name === 'TimeoutError' ? 'il ponte non risponde' : 'ponte non raggiungibile'
      throw new PonteError(msg)
    }
    if (r.status === 401) throw new PonteError('token del ponte errato')
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null
      throw new PonteError(j?.error ?? `errore del ponte (HTTP ${r.status})`)
    }
    return r
  }

  async heartbeat(payload: Record<string, unknown>): Promise<PonteAlarm[]> {
    const r = await this.request('POST', '/api/heartbeat', JSON.stringify(payload), 'application/json')
    const j = (await r.json()) as { alarms?: PonteAlarm[] }
    return j.alarms ?? []
  }

  async metadata(artist: string, title: string): Promise<void> {
    await this.request('POST', '/api/metadata', JSON.stringify({ artist, title }), 'application/json', 5000)
  }

  async state(): Promise<PonteState> {
    return (await (await this.request('GET', '/api/stato')).json()) as PonteState
  }

  async testNotification(): Promise<{ ok: boolean; results: { channel: string; ok: boolean; error?: string }[] }> {
    return (await (await this.request('POST', '/api/test-notifica', undefined, undefined, 20_000)).json()) as {
      ok: boolean
      results: { channel: string; ok: boolean; error?: string }[]
    }
  }

  async uploadBackup(data: Uint8Array): Promise<string> {
    const r = await this.request('PUT', '/api/backup', new Blob([data as Uint8Array<ArrayBuffer>]), 'application/octet-stream', 5 * 60_000)
    return ((await r.json()) as { name: string }).name
  }

  async listBackups(): Promise<PonteBackup[]> {
    return (await (await this.request('GET', '/api/backup')).json()) as PonteBackup[]
  }

  async downloadBackup(name: string): Promise<Uint8Array> {
    const r = await this.request('GET', `/api/backup/${encodeURIComponent(name)}`, undefined, undefined, 5 * 60_000)
    return new Uint8Array(await r.arrayBuffer())
  }
}

/** Il backup automatico è dovuto? Una volta al giorno, all'ora scelta o appena dopo. */
export function backupDue(now: Date, hour: number, last: Date | null): boolean {
  if (hour < 0 || hour > 23) return false
  const today = new Date(now)
  today.setHours(hour, 0, 0, 0)
  if (now < today) return false
  return !last || last < today
}
