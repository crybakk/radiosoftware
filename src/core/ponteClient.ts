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
  lastIcecastError: string | null
  alarms: PonteAlarm[]
  liquidsoap: { studio?: boolean; esterna?: boolean } | null
  notifiche: string[]
}

export class PonteError extends Error {}

export class PonteClient {
  private base: string
  private token: string

  constructor(host: string, port: number, token: string, https = false) {
    const h = host.trim().replace(/\/+$/, '')
    // si può scrivere anche l'indirizzo completo (https://ponte.esempio.it:8443)
    this.base = /^https?:\/\//i.test(h) ? h : `${https ? 'https' : 'http'}://${h}:${port}`
    this.token = token
  }

  private async request(
    method: string,
    path: string,
    body?: BodyInit,
    type?: string,
    timeoutMs = 10_000,
    signal?: AbortSignal
  ): Promise<Response> {
    let r: Response
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      r = await fetch(this.base + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(type ? { 'Content-Type': type } : {}) },
        body,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        // corpo in streaming (file della libreria)
        ...(body && typeof (body as ReadableStream).getReader === 'function' ? { duplex: 'half' } : {})
      } as RequestInit)
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

  /** Brani della regia già presenti sul server. */
  async listLibrary(): Promise<{ id: string; size: number }[]> {
    return (await (await this.request('GET', '/api/libreria', undefined, undefined, 60_000)).json()) as { id: string; size: number }[]
  }

  /** Carica un file nella libreria del server (in streaming). */
  async uploadLibraryFile(meta: LibraryMeta, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
    const q = new URLSearchParams({
      id: meta.id,
      titolo: meta.title,
      artista: meta.artist,
      durata: String(meta.duration),
      guadagno: String(meta.gainDb)
    })
    await this.request('PUT', `/api/libreria?${q}`, body, 'application/octet-stream', 60 * 60_000, signal)
  }

  async deleteLibraryFile(id: string): Promise<void> {
    await this.request('DELETE', `/api/libreria?${new URLSearchParams({ id })}`)
  }

  /** Titoli e volumi aggiornati (anche per i file copiati a mano). */
  async sendLibraryMeta(tracks: LibraryMeta[]): Promise<number> {
    const r = await this.request('POST', '/api/libreria/dati', JSON.stringify({ tracks }), 'application/json', 60_000)
    return ((await r.json()) as { updated: number }).updated
  }

  /** Impronte audio già sul server: id e numero di valori. */
  async listFingerprints(): Promise<{ id: string; n: number }[]> {
    return (await (await this.request('GET', '/api/impronte', undefined, undefined, 60_000)).json()) as { id: string; n: number }[]
  }

  /** Più impronte in un corpo solo: [lunghezza u32 LE][file impronta]… */
  async uploadFingerprints(body: Uint8Array): Promise<number> {
    const r = await this.request('PUT', '/api/impronte', new Blob([body as Uint8Array<ArrayBuffer>]), 'application/octet-stream', 5 * 60_000)
    return ((await r.json()) as { saved: number }).saved
  }

  async deleteFingerprints(ids: string[]): Promise<void> {
    await this.request('DELETE', '/api/impronte', JSON.stringify({ ids }), 'application/json', 60_000)
  }

  /** Brani caricati dal pannello sul server, da scaricare in regia. */
  async listUploaded(): Promise<UploadedTrack[]> {
    return (await (await this.request('GET', '/api/caricati', undefined, undefined, 60_000)).json()) as UploadedTrack[]
  }

  async downloadUploaded(id: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const r = await this.request('GET', `/api/caricati/file?${new URLSearchParams({ id })}`, undefined, undefined, 60 * 60_000, signal)
    if (!r.body) throw new PonteError('risposta vuota dal ponte')
    return r.body
  }

  /** Il brano scaricato prende sul server il percorso che ha in regia (così non si ricarica). */
  async moveUploaded(from: string, to: string): Promise<void> {
    await this.request('POST', '/api/caricati/sposta', JSON.stringify({ da: from, a: to }), 'application/json', 60_000)
  }

  /** Brani suonati dal server (diretta autonoma, musica di riserva) con inizio in [from, to). */
  async listPlays(from: Date, to: Date): Promise<ServerPlay[]> {
    const q = new URLSearchParams({ da: from.toISOString(), a: to.toISOString() })
    return (await (await this.request('GET', `/api/registro?${q}`, undefined, undefined, 60_000)).json()) as ServerPlay[]
  }

  async downloadBackup(name: string): Promise<Uint8Array> {
    const r = await this.request('GET', `/api/backup/${encodeURIComponent(name)}`, undefined, undefined, 5 * 60_000)
    return new Uint8Array(await r.arrayBuffer())
  }
}

export interface UploadedTrack {
  id: string
  size: number
  title: string
  artist: string
  duration: number
}

/** Voce del registro del server (vedi ponte/controllo/src/registro.ts). */
export interface ServerPlay {
  at: string
  source: 'autonoma' | 'riserva' | 'esterna'
  id: string
  title: string
  artist: string
  duration: number
  /** Solo per i brani sconosciuti etichettati dal pannello. */
  composer?: string
  publisher?: string
}

export interface LibraryMeta {
  id: string
  title: string
  artist: string
  duration: number
  gainDb: number
}

/** Il backup automatico è dovuto? Una volta al giorno, all'ora scelta o appena dopo. */
export function backupDue(now: Date, hour: number, last: Date | null): boolean {
  if (hour < 0 || hour > 23) return false
  const today = new Date(now)
  today.setHours(hour, 0, 0, 0)
  if (now < today) return false
  return !last || last < today
}
