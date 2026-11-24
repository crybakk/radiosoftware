/** Dialogo con il servizio di controllo del ponte (HTTP + token). */
import type { FineRegia } from './registrazioneProgrammi'
import type { Report, Sample } from '../../ponte/controllo/src/ascoltatori.ts'

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

/** Titolo parlato (quando non suona nessun brano): anteprima e testo libero. */
export interface SpokenTitleState {
  testo: string
  programma: string | null
  artist: string
  title: string
  /** Va in onda adesso. */
  inOnda: boolean
  max: number
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

export class PonteError extends Error {
  /** Codice HTTP della risposta del ponte (assente se il ponte non è raggiungibile). */
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

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
    if (r.status === 401) throw new PonteError('token del ponte errato', 401)
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null
      throw new PonteError(j?.error ?? `errore del ponte (HTTP ${r.status})`, r.status)
    }
    return r
  }

  /** Segnale di vita: risponde con gli allarmi e la durata massima dei brani scelta nel pannello (se il server la conosce). */
  async heartbeat(payload: Record<string, unknown>): Promise<{ alarms: PonteAlarm[]; maxTrackMinutes: number | null }> {
    const r = await this.request('POST', '/api/heartbeat', JSON.stringify(payload), 'application/json')
    const j = (await r.json()) as { alarms?: PonteAlarm[]; maxTrackMinutes?: unknown }
    const max = Number(j.maxTrackMinutes)
    return { alarms: j.alarms ?? [], maxTrackMinutes: j.maxTrackMinutes != null && Number.isFinite(max) && max >= 0 ? max : null }
  }

  async metadata(artist: string, title: string, duration = 0): Promise<void> {
    await this.request('POST', '/api/metadata', JSON.stringify({ artist, title, duration }), 'application/json', 5000)
  }

  /** Non suona nessun brano: il ponte manda il titolo parlato (programma e conduttore, o nome della radio). */
  async spoken(): Promise<void> {
    await this.request('POST', '/api/metadata', JSON.stringify({ parlato: true }), 'application/json', 5000)
  }

  /** Titolo parlato: anteprima e testo libero. */
  async spokenTitle(): Promise<SpokenTitleState> {
    return (await (await this.request('GET', '/api/titolo-parlato', undefined, undefined, 5000)).json()) as SpokenTitleState
  }

  async setSpokenText(testo: string): Promise<SpokenTitleState> {
    return (await (await this.request('POST', '/api/titolo-parlato', JSON.stringify({ testo }), 'application/json', 5000)).json()) as SpokenTitleState
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

  /** Statistiche degli ascoltatori di un giorno o di una settimana (data AAAA-MM-GG). */
  async listenerStats(periodo: 'giorno' | 'settimana', data: string): Promise<ListenerStats> {
    const q = new URLSearchParams({ periodo, data })
    return (await (await this.request('GET', `/api/ascoltatori?${q}`, undefined, undefined, 30_000)).json()) as ListenerStats
  }

  /** Programmi del server con le puntate pubblicate (dalla più recente), per le repliche. */
  async listPrograms(): Promise<PonteProgram[]> {
    const list = (await (await this.request('GET', '/api/programmi/regia')).json()) as PonteProgram[]
    // l'audio si ascolta dall'indirizzo pubblico del ponte
    return list.map((p) => ({ ...p, episodes: p.episodes.map((e) => ({ ...e, path: this.base + e.path })) }))
  }

  /** Fine della registrazione in regia: il ponte dice se tiene la sua ("ponte") o se serve il file ("regia"). */
  async fineRegistrazione(f: FineRegia): Promise<{ usa: 'ponte' | 'regia' }> {
    const r = await this.request('POST', '/api/programmi/regia/fine', JSON.stringify(f), 'application/json', 30_000)
    return (await r.json()) as { usa: 'ponte' | 'regia' }
  }

  /** Manda il file della registrazione della regia (in streaming). */
  async inviaRegistrazione(f: FineRegia, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
    const q = new URLSearchParams({
      programId: f.programId,
      startedAt: String(f.startedAt),
      endedAt: String(f.endedAt),
      startMark: f.startMark === null ? '' : String(f.startMark),
      endMark: f.endMark === null ? '' : String(f.endMark),
      startAuto: f.startAuto ? '1' : '0',
      endAuto: f.endAuto ? '1' : '0'
    })
    await this.request('PUT', `/api/programmi/regia/registrazione?${q}`, body, 'audio/mpeg', 6 * 3600_000, signal)
  }

  async downloadBackup(name: string): Promise<Uint8Array> {
    const r = await this.request('GET', `/api/backup/${encodeURIComponent(name)}`, undefined, undefined, 5 * 60_000)
    return new Uint8Array(await r.arrayBuffer())
  }
}

export type ListenerStats = Report & {
  now: Sample | null
  /** Icecast secondario configurato sul server. */
  secondary: boolean
  periodo: 'giorno' | 'settimana'
}

export interface PonteProgram {
  id: string
  title: string
  /** Fasce del palinsesto (giorni 0 = domenica, orari "HH:MM"); assenti con un ponte vecchio. */
  slots?: { days: number[]; start: string; end: string }[]
  /** Va in onda dallo studio: la regia lo registra anche lei (assente con un ponte vecchio). */
  studio?: boolean
  /** Minuti registrati dopo la fascia (impostazione del pannello). */
  marginMinutes?: number
  /** Puntate pubblicate; path è l'indirizzo completo dell'audio. */
  episodes: { id: string; title: string; length: number; path: string }[]
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
  /** Quando il server ha scritto la voce, se diverso dall'inizio (brano etichettato dopo): non serve all'importazione. */
  added?: string
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
