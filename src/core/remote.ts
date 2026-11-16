/** Controllo remoto dal lato regia: collegamento al ponte, stato da inviare, esecuzione dei comandi. */
import type { FromStudio, RemoteCommand, RemoteState, RemoteTrack, ToStudio } from '../../ponte/controllo/src/protocol.ts'
import type { PlayoutEngine, PlayoutSnapshot } from './playout'
import { ponteControlBase } from './ponteClient'
import type { Track } from './types'

export type { RemoteCommand, RemoteState }

export function remoteTrack(t: Track): RemoteTrack {
  return { id: t.id, title: t.title, artist: t.artist, kind: t.kind, duration: Math.max(0, (t.cueOut || t.duration) - t.cueIn) }
}

/** Riassunto dello stato della regia per il pannello (niente percorsi di file). */
export function toRemoteState(s: PlayoutSnapshot, carts: (Track | null)[], uplink: string, now = new Date()): RemoteState {
  const cur = s.onAir.at(-1)
  const playing = new Set(s.carts.map((c) => c.track.id))
  return {
    mode: s.mode,
    onAir: cur
      ? { ...remoteTrack(cur.track), position: Math.max(0, cur.position - cur.track.cueIn), remaining: cur.remaining }
      : null,
    queue: s.queue.map((q) => ({ ...remoteTrack(q.track), uid: q.uid, eta: q.eta, origin: q.origin, eventLabel: q.eventLabel })),
    carts: carts.map((t, i) => ({ n: i + 1, name: t ? t.title || t.artist : null, playing: !!t && playing.has(t.id) })),
    uplink,
    lastError: s.lastError,
    at: now.toISOString()
  }
}

export interface RemoteDeps {
  getTrack(id: number): Promise<Track | null>
  search(q: string): Promise<Track[]>
  carts(): (Track | null)[]
  /** Puntata da mandare in replica (dal server). */
  replay(programId: string, episodeId?: string): Promise<Track | null>
}

/** Esegue un comando arrivato dal pannello. Restituisce i dati della risposta o lancia un errore leggibile. */
export async function executeRemote(engine: PlayoutEngine, cmd: RemoteCommand, deps: RemoteDeps): Promise<unknown> {
  switch (cmd.type) {
    case 'play':
      return engine.play()
    case 'next':
      return engine.next()
    case 'stop':
      return engine.stop()
    case 'mode':
      if (cmd.mode !== 'auto' && cmd.mode !== 'manual') throw new Error('modalità non valida')
      return engine.setMode(cmd.mode)
    case 'cart': {
      const t = deps.carts()[cmd.n - 1]
      if (!t) throw new Error('tasto jingle vuoto')
      return engine.playCart(t)
    }
    case 'stopCarts':
      return engine.stopCarts()
    case 'enqueue': {
      const t = await deps.getTrack(cmd.trackId)
      if (!t) throw new Error('brano non trovato')
      engine.enqueue(t, cmd.where === 'next' ? 0 : undefined)
      return null
    }
    case 'remove':
      return engine.remove(cmd.uid)
    case 'move':
      return engine.move(cmd.uid, cmd.delta < 0 ? -1 : 1)
    case 'replay': {
      const t = await deps.replay(String(cmd.programId ?? ''), cmd.episodeId ? String(cmd.episodeId) : undefined)
      if (!t) throw new Error('puntata non trovata sul server')
      engine.enqueue(t, cmd.where === 'end' ? undefined : 0)
      return null
    }
    case 'search':
      return (await deps.search(String(cmd.q ?? '').slice(0, 200))).map(remoteTrack)
    default:
      throw new Error('comando sconosciuto')
  }
}

export type RemoteLinkState = 'spento' | 'connessione' | 'collegato' | 'errore'

export interface RemoteLinkStatus {
  state: RemoteLinkState
  message: string
}

type WsCtor = new (url: string) => WebSocket

export interface RemoteLinkOptions {
  /**
   * Dopo il primo ping del ponte: se per tanto tempo non arriva nulla il collegamento è morto
   * (il 4G a volte lo lascia "aperto" senza che passi niente) e lo riapriamo. Millisecondi.
   */
  silenceMs?: number
}

/** Il ponte manda un ping ogni 15 s: senza notizie per 40 s il collegamento è considerato caduto. */
const SILENCE_MS = 40_000
/** Ricerche dai pannelli in attesa sulla regia, al massimo (oltre si risponde "riprova"). */
const MAX_SEARCHES_WAITING = 4

/**
 * Canale WebSocket dalla regia al ponte. È la regia ad aprirlo (funziona anche dietro il NAT del 4G)
 * e lo riapre da sola se cade.
 */
export class RemoteLink {
  private ws: WebSocket | null = null
  private url = ''
  private token = ''
  private wanted = false
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastSent = 0
  private pendingState: RemoteState | null = null
  private stateTimer: ReturnType<typeof setTimeout> | null = null
  private status: RemoteLinkStatus = { state: 'spento', message: 'Controllo remoto spento' }
  private onCommand: (cmd: RemoteCommand, by: string) => Promise<unknown>
  private onStatus: (s: RemoteLinkStatus) => void
  private Ws: WsCtor
  private silenceMs: number
  private watchdog: ReturnType<typeof setInterval> | null = null
  /** I comandi (tranne la ricerca) vengono eseguiti uno alla volta, nell'ordine di arrivo. */
  private queue: Promise<unknown> = Promise.resolve()
  private searchQueue: Promise<unknown> = Promise.resolve()
  private searchesWaiting = 0

  constructor(
    onCommand: (cmd: RemoteCommand, by: string) => Promise<unknown>,
    onStatus: (s: RemoteLinkStatus) => void,
    Ws: WsCtor = globalThis.WebSocket as unknown as WsCtor,
    options: RemoteLinkOptions = {}
  ) {
    this.onCommand = onCommand
    this.onStatus = onStatus
    this.Ws = Ws
    this.silenceMs = options.silenceMs ?? SILENCE_MS
  }

  getStatus(): RemoteLinkStatus {
    return this.status
  }

  private set(state: RemoteLinkState, message: string): void {
    this.status = { state, message }
    this.onStatus(this.status)
  }

  start(url: string, token: string): void {
    if (this.wanted && url === this.url && token === this.token) return
    this.stop()
    this.url = url
    this.token = token
    this.wanted = true
    this.attempt = 0
    this.open()
  }

  stop(): void {
    this.wanted = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.stopWatchdog()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.close()
    }
    if (this.status.state !== 'spento') this.set('spento', 'Controllo remoto spento')
  }

  private open(): void {
    if (!this.wanted) return
    this.set('connessione', 'Collegamento al ponte…')
    let ws: WebSocket
    try {
      ws = new this.Ws(this.url)
    } catch (e) {
      this.retry(e instanceof Error ? e.message : String(e))
      return
    }
    this.ws = ws
    let authed = false
    // segnale di vita: si controlla solo dopo il primo ping (un ponte vecchio non li manda)
    let pinged = false
    let lastSeen = Date.now()
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.token } satisfies FromStudio))
    ws.onmessage = (ev: MessageEvent) => {
      // messaggi in ritardo da un collegamento già abbandonato
      if (this.ws !== ws) return
      lastSeen = Date.now()
      let msg: ToStudio
      try {
        msg = JSON.parse(String(ev.data)) as ToStudio
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.t === 'ping') {
        if (!pinged) {
          pinged = true
          this.startWatchdog(ws, () => Date.now() - lastSeen > this.silenceMs)
        }
      } else if (msg.t === 'auth-ok') {
        authed = true
        this.attempt = 0
        this.set('collegato', 'Pannello remoto collegato al ponte')
        if (this.pendingState) this.flushState()
      } else if (msg.t === 'cmd') {
        const { id, cmd, by } = msg
        // la ricerca non tocca la messa in onda: non aspetta gli altri comandi, ma le ricerche vanno
        // una alla volta e poche in attesa, perché tanti pannelli insieme non blocchino la regia
        const run = cmd?.type === 'search' ? this.enqueueSearch(() => this.onCommand(cmd, by)) : this.enqueue(() => this.onCommand(cmd, by))
        run.then(
          (data) => this.send({ t: 'reply', id, ok: true, data: data ?? undefined }),
          (e: unknown) => this.send({ t: 'reply', id, ok: false, error: e instanceof Error ? e.message : String(e) })
        )
      }
    }
    const down = (code: number): void => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopWatchdog()
      const reason = code === 4003 ? 'token del ponte errato' : authed ? 'collegamento interrotto' : 'il ponte non risponde'
      this.retry(reason)
    }
    ws.onclose = (ev: CloseEvent) => down(ev.code)
    // se il ponte rifiuta la connessione alcuni client segnalano solo l'errore, senza chiusura
    ws.onerror = () => {
      setTimeout(() => {
        if (ws.readyState !== 1) down(0)
      }, 500)
    }
  }

  private enqueueSearch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.searchesWaiting >= MAX_SEARCHES_WAITING) return Promise.reject(new Error('troppe ricerche insieme: riprova tra poco'))
    this.searchesWaiting++
    const run = this.searchQueue.then(fn).finally(() => this.searchesWaiting--)
    this.searchQueue = run.catch(() => {})
    return run
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => {})
    return run
  }

  private startWatchdog(ws: WebSocket, silent: () => boolean): void {
    this.stopWatchdog()
    const every = Math.max(10, Math.min(5000, Math.floor(this.silenceMs / 4)))
    this.watchdog = setInterval(() => {
      if (this.ws !== ws || !silent()) return
      // nessun segno di vita: chiudiamo e passiamo per la solita riconnessione
      this.stopWatchdog()
      ws.onclose = null
      ws.onerror = null
      try {
        ws.close()
      } catch {
        // già chiuso
      }
      this.ws = null
      this.retry('il ponte non dà più segni di vita')
    }, every)
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
  }

  private retry(message: string): void {
    if (!this.wanted) return
    this.attempt++
    const wait = Math.min(30, 2 ** Math.min(this.attempt, 5))
    this.set('errore', `${message}: nuovo tentativo tra ${wait} s`)
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, wait * 1000)
  }

  private send(m: FromStudio): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m))
  }

  /** Stato da mostrare nel pannello: al massimo due invii al secondo. */
  sendState(state: RemoteState): void {
    this.pendingState = state
    if (this.status.state !== 'collegato' || this.stateTimer) return
    const wait = Math.max(0, 500 - (Date.now() - this.lastSent))
    this.stateTimer = setTimeout(() => this.flushState(), wait)
  }

  private flushState(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer)
    this.stateTimer = null
    if (!this.pendingState || this.status.state !== 'collegato') return
    this.send({ t: 'state', state: this.pendingState })
    this.pendingState = null
    this.lastSent = Date.now()
  }
}

/** Indirizzo del canale: ws:// o wss:// a seconda di come è raggiungibile il ponte. */
export function remoteUrl(host: string, port: number, https: boolean): string {
  return `${ponteControlBase(host, port, https).replace(/^http/i, 'ws')}/ws/regia`
}
