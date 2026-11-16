import { dueEvents } from './events'
import { airTime } from './rotation'
import { gainForTrack, type QueueItem, type ScheduledEvent, type Track } from './types'

/** Un lettore audio che suona un singolo brano. */
export interface Player {
  /** Avvia la riproduzione dal punto di inizio (cueIn). Rifiuta se il file non si può leggere. */
  start(): Promise<void>
  /** Posizione corrente nel file, in secondi. */
  position(): number
  /** Sfuma a zero in `seconds` e poi si ferma. */
  fadeOut(seconds: number): void
  stop(): void
  onEnded(cb: () => void): void
}

export interface AudioBackend {
  createPlayer(track: Track, gainDb: number): Player
}

/** Servizi esterni al motore: database, rotazione, registro. */
export interface PlayoutHost {
  /** Restituisce `count` brani da accodare in automatico, dati i brani già in coda e il loro orario stimato. */
  fillQueue(upcoming: { track: Track; at: Date }[], count: number): Promise<Track[]>
  logStart(track: Track, at: Date): Promise<number>
  logEnd(logId: number, at: Date, playedSeconds: number): Promise<void>
  /**
   * Trasforma le azioni di un evento in passi per il motore. Le azioni che non
   * riguardano la coda (regole di rotazione, comandi esterni) le esegue l'host.
   */
  expandEvent(event: ScheduledEvent): Promise<EngineStep[]>
}

/** Passo eseguito dal motore per conto di un evento. */
export type EngineStep =
  | { kind: 'tracks'; tracks: Track[]; placement: 'front' | 'append' | 'replace' }
  | { kind: 'mode'; mode: PlayoutMode }
  | { kind: 'clear' }
  | { kind: 'stop' }
  | { kind: 'error'; message: string }

export type PlayoutMode = 'auto' | 'manual'

export interface PlayoutOptions {
  crossfadeSeconds: number
  targetLoudness: number
  autoQueueLength: number
}

export interface OnAirInfo {
  uid: string
  track: Track
  origin: QueueItem['origin']
  position: number
  /** Secondi alla fine dell'audio. */
  remaining: number
  /** Secondi al punto di mix (quando partirà il successivo). */
  toMix: number
  fading: boolean
}

export interface PlayoutSnapshot {
  mode: PlayoutMode
  /** Brani in onda: l'ultimo è quello principale, gli altri stanno sfumando. */
  onAir: OnAirInfo[]
  queue: (QueueItem & { eta: string })[]
  carts: { uid: string; track: Track; position: number; remaining: number }[]
  lastError: string | null
}

interface Slot {
  item: QueueItem
  player: Player
  logId: number | null
  startedAt: Date
  mixTriggered: boolean
  fading: boolean
  ended: boolean
}

/** Identifica un jingle della cartwall (i brani della libreria per id, gli altri per file). */
function cartKey(t: Track): string {
  return t.id > 0 ? `id:${t.id}` : `file:${t.path}`
}

let uidCounter = 0
export function newUid(): string {
  uidCounter++
  return `${Date.now().toString(36)}-${uidCounter.toString(36)}`
}

/**
 * Motore di messa in onda. Non dipende da Electron né dal browser: l'audio passa
 * dall'AudioBackend, il tempo dall'orologio, così si può testare con un tempo finto.
 */
export class PlayoutEngine {
  private mode: PlayoutMode = 'manual'
  private queue: QueueItem[] = []
  private slots: Slot[] = []
  private carts: Slot[] = []
  private events: ScheduledEvent[] = []
  private lastEventCheck: Date
  /** Occorrenze già eseguite (id evento @ orario), per non ripeterle se l'orologio torna indietro. */
  private firedEvents = new Map<string, number>()
  private starting = false
  /** Jingle della cartwall che stanno caricando. */
  private cartsStarting = new Set<string>()
  private filling = false
  private lastError: string | null = null
  /** Tolleranza degli eventi soft: uid del brano evento da proteggere -> ora limite. */
  private eventDeadlines = new Map<string, Date>()
  /** Vero dopo STOP: nessun brano riparte da solo finché la regia non lo chiede. */
  private stopped = false
  /** Cresce a ogni STOP: un brano che stava caricando quando è stato premuto non va in onda. */
  private generation = 0
  private listeners = new Set<(s: PlayoutSnapshot) => void>()

  constructor(
    private backend: AudioBackend,
    private host: PlayoutHost,
    private options: PlayoutOptions,
    private now: () => Date = () => new Date()
  ) {
    this.lastEventCheck = now()
  }

  // ---------- configurazione ----------

  setOptions(o: Partial<PlayoutOptions>): void {
    this.options = { ...this.options, ...o }
  }

  setEvents(events: ScheduledEvent[]): void {
    this.events = events
  }

  subscribe(cb: (s: PlayoutSnapshot) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // ---------- comandi ----------

  setMode(mode: PlayoutMode): void {
    this.mode = mode
    if (mode === 'auto') this.stopped = false
    this.emit()
  }

  getMode(): PlayoutMode {
    return this.mode
  }

  /** Avvia il primo brano in coda se non c'è nulla in onda. */
  async play(): Promise<void> {
    this.stopped = false
    if (!this.current()) await this.startNext()
  }

  /** Sfuma il brano in onda e passa subito al successivo. */
  async next(): Promise<void> {
    this.stopped = false
    const cur = this.current()
    if (cur) this.fade(cur, this.options.crossfadeSeconds)
    await this.startNext()
  }

  /** Ferma tutto con una breve sfumatura e passa in manuale. */
  stop(): void {
    this.mode = 'manual'
    this.stopped = true
    this.generation++
    this.eventDeadlines.clear()
    for (const s of this.slots) this.fade(s, 1)
    this.emit()
  }

  enqueue(track: Track, index?: number, origin: QueueItem['origin'] = 'manual'): QueueItem {
    const item: QueueItem = { uid: newUid(), track, origin }
    const i = index == null ? this.queue.length : Math.max(0, Math.min(index, this.queue.length))
    this.queue.splice(i, 0, item)
    this.emit()
    return item
  }

  remove(uid: string): void {
    this.queue = this.queue.filter((q) => q.uid !== uid)
    this.eventDeadlines.delete(uid)
    this.emit()
  }

  move(uid: string, delta: number): void {
    const i = this.queue.findIndex((q) => q.uid === uid)
    if (i < 0) return
    const j = Math.max(0, Math.min(this.queue.length - 1, i + delta))
    const [item] = this.queue.splice(i, 1)
    this.queue.splice(j, 0, item)
    this.emit()
  }

  clearQueue(): void {
    this.queue = []
    this.eventDeadlines.clear()
    this.emit()
  }

  /**
   * Suona un jingle dalla cartwall, sopra a quello che è in onda.
   * Se lo stesso jingle sta già suonando (o sta partendo) il clic viene ignorato: niente due copie sovrapposte.
   */
  async playCart(track: Track): Promise<void> {
    const key = cartKey(track)
    if (this.cartsStarting.has(key) || this.carts.some((c) => !c.ended && !c.fading && cartKey(c.item.track) === key)) return
    const item: QueueItem = { uid: newUid(), track, origin: 'manual' }
    this.cartsStarting.add(key)
    try {
      const slot = await this.launch(item, this.carts)
      if (!slot) this.emit()
    } finally {
      this.cartsStarting.delete(key)
    }
  }

  stopCarts(): void {
    for (const c of this.carts) this.fade(c, 0.5)
    this.emit()
  }

  // ---------- ciclo ----------

  /** Da chiamare spesso (ogni 100-250 ms). */
  async tick(): Promise<void> {
    const now = this.now()

    // 1. eventi a orario
    // Se l'orologio del PC torna indietro un evento già eseguito non deve scattare di nuovo:
    // ogni occorrenza (evento + orario) parte una volta sola.
    const due = dueEvents(this.events, this.lastEventCheck, now)
    this.lastEventCheck = now
    for (const [key, at] of this.firedEvents) if (at < now.getTime() - 10 * 60_000) this.firedEvents.delete(key)
    for (const { event, at } of due) {
      const key = `${event.id}@${at.getTime()}`
      if (this.firedEvents.has(key)) continue
      this.firedEvents.set(key, at.getTime())
      await this.runEvent(event, now)
    }

    // 1b. tolleranza scaduta: l'evento in testa alla coda non aspetta oltre
    const head = this.queue[0]
    const deadline = head ? this.eventDeadlines.get(head.uid) : undefined
    if (head && deadline && now >= deadline) {
      this.eventDeadlines.delete(head.uid)
      if (head.origin === 'event' && this.current()) await this.next()
    }

    // 2. passaggio al brano successivo al punto di mix
    const cur = this.current()
    // Un brano di durata sconosciuta (non analizzato) passa al successivo solo quando finisce davvero.
    if (cur && !cur.mixTriggered && !cur.fading && this.knownLength(cur.item.track)) {
      const pos = cur.player.position()
      if (pos >= this.mixPoint(cur.item.track)) {
        cur.mixTriggered = true
        if (this.mode === 'auto' || this.queue[0]?.origin === 'event') await this.startNext()
      }
    }

    // 3. in automatico non si resta mai muti
    if (this.mode === 'auto' && !this.current() && !this.starting) await this.startNext()

    // 4. riempimento della coda in automatico
    if (this.mode === 'auto' && this.queue.length < this.options.autoQueueLength && !this.filling) {
      this.filling = true
      try {
        const etas = this.etas()
        const upcoming = this.queue.map((q, i) => ({ track: q.track, at: etas[i] }))
        const tracks = await this.host.fillQueue(upcoming, this.options.autoQueueLength - this.queue.length)
        for (const t of tracks) this.queue.push({ uid: newUid(), track: t, origin: 'auto' })
      } finally {
        this.filling = false
      }
    }

    this.emit()
  }

  snapshot(): PlayoutSnapshot {
    const etas = this.etas()
    const live = this.slots.filter((s) => !s.ended)
    return {
      mode: this.mode,
      onAir: live.map((s) => {
        const pos = s.player.position()
        return {
          uid: s.item.uid,
          track: s.item.track,
          origin: s.item.origin,
          position: pos,
          remaining: Math.max(0, this.endPoint(s.item.track) - pos),
          toMix: Math.max(0, this.mixPoint(s.item.track) - pos),
          fading: s.fading
        }
      }),
      queue: this.queue.map((q, i) => ({ ...q, eta: etas[i].toISOString() })),
      carts: this.carts
        .filter((c) => !c.ended)
        .map((c) => {
          const pos = c.player.position()
          return {
            uid: c.item.uid,
            track: c.item.track,
            position: pos,
            remaining: Math.max(0, this.endPoint(c.item.track) - pos)
          }
        }),
      lastError: this.lastError
    }
  }

  /** Esegue subito un evento (usato dagli orari e dal tasto "Prova" nell'interfaccia). */
  async runEvent(event: ScheduledEvent, now: Date = this.now()): Promise<void> {
    this.stopped = false
    let steps: EngineStep[]
    try {
      steps = await this.host.expandEvent(event)
    } catch (err) {
      this.lastError = `Evento "${event.label || event.time}": ${err instanceof Error ? err.message : String(err)}`
      return
    }
    let insertAt = 0
    while (insertAt < this.queue.length && this.queue[insertAt].origin === 'event') insertAt++
    let queuedFront = false
    let stopped = false
    let protect: string | null = null
    for (const step of steps) {
      switch (step.kind) {
        case 'error':
          this.lastError = `Evento "${event.label || event.time}": ${step.message}`
          break
        case 'mode':
          this.mode = step.mode
          break
        case 'clear':
          this.queue = []
          this.eventDeadlines.clear()
          protect = null
          insertAt = 0
          break
        case 'stop':
          this.stop()
          stopped = true
          break
        case 'tracks': {
          const items = step.tracks.map(
            (track): QueueItem => ({ uid: newUid(), track, origin: 'event', eventLabel: event.label || undefined })
          )
          if (!items.length) break
          if (step.placement === 'append') {
            for (const it of items) this.queue.push({ ...it, origin: 'manual' })
          } else {
            if (step.placement === 'replace') {
              this.queue = []
              this.eventDeadlines.clear()
              protect = null
              insertAt = 0
            }
            protect ??= items[0].uid
            this.queue.splice(insertAt, 0, ...items)
            insertAt += items.length
            queuedFront = true
          }
          break
        }
      }
    }
    if (queuedFront && !stopped) {
      const cur = this.current()
      if (!cur) {
        // gli eventi partono anche se la regia è ferma
        await this.startNext()
      } else if (event.mode === 'hard') {
        await this.next()
      } else if (event.toleranceSeconds > 0 && protect) {
        this.eventDeadlines.set(protect, new Date(now.getTime() + event.toleranceSeconds * 1000))
      }
    }
    // Un "Ferma tutto" dell'evento seguito da brani dell'evento: i brani partono
    // alla fine della sfumatura, come previsto dall'evento.
    if (stopped && queuedFront) this.stopped = false
    this.emit()
  }

  // ---------- interni ----------

  private current(): Slot | undefined {
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i]
      if (!s.ended && !s.fading) return s
    }
    return undefined
  }

  private mixPoint(t: Track): number {
    if (t.mixPoint > t.cueIn) return t.mixPoint
    return this.endPoint(t)
  }

  /** Falso per i brani di cui non si conosce la fine (durata 0, non ancora analizzati). */
  private knownLength(t: Track): boolean {
    return this.endPoint(t) > t.cueIn
  }

  private endPoint(t: Track): number {
    if (t.cueOut > t.cueIn) return t.cueOut
    return t.duration
  }

  /** Orario stimato di partenza di ogni brano in coda. */
  private etas(): Date[] {
    const now = this.now().getTime()
    const cur = this.current()
    let t = now
    if (cur) t += Math.max(0, this.mixPoint(cur.item.track) - cur.player.position()) * 1000
    return this.queue.map((q) => {
      const at = new Date(t)
      t += airTime(q.track) * 1000
      return at
    })
  }

  private fade(slot: Slot, seconds: number): void {
    if (slot.ended || slot.fading) return
    slot.fading = true
    slot.player.fadeOut(seconds)
  }

  private async startNext(): Promise<void> {
    if (this.starting) return
    this.starting = true
    try {
      // prova fino a 3 brani: se un file è sparito o rovinato passa al successivo
      const gen = this.generation
      for (let attempt = 0; attempt < 3 && this.queue.length; attempt++) {
        const item = this.queue.shift()!
        this.eventDeadlines.delete(item.uid)
        const slot = await this.launch(item, this.slots)
        if (slot) break
        if (gen !== this.generation) {
          // STOP premuto mentre il brano caricava: non va in onda, torna in testa alla coda
          this.queue.unshift(item)
          break
        }
      }
    } finally {
      this.starting = false
      this.emit()
    }
  }

  private async launch(item: QueueItem, list: Slot[]): Promise<Slot | null> {
    const player = this.backend.createPlayer(item.track, gainForTrack(item.track, this.options.targetLoudness))
    const slot: Slot = {
      item,
      player,
      logId: null,
      startedAt: this.now(),
      mixTriggered: false,
      fading: false,
      ended: false
    }
    player.onEnded(() => void this.finish(slot, list))
    const gen = this.generation
    const stale = (): boolean => list === this.slots && gen !== this.generation
    try {
      await player.start()
    } catch (err) {
      if (stale()) {
        slot.ended = true
        return null
      }
      this.lastError = `Impossibile riprodurre "${item.track.artist} - ${item.track.title}": ${
        err instanceof Error ? err.message : String(err)
      }`
      return null
    }
    if (stale()) {
      // STOP premuto durante il caricamento
      slot.ended = true
      player.stop()
      return null
    }
    slot.startedAt = this.now()
    list.push(slot)
    this.lastError = null
    try {
      slot.logId = await this.host.logStart(item.track, slot.startedAt)
    } catch {
      // il registro non deve mai fermare la messa in onda
    }
    return slot
  }

  private async finish(slot: Slot, list: Slot[]): Promise<void> {
    if (slot.ended) return
    slot.ended = true
    const i = list.indexOf(slot)
    if (i >= 0) list.splice(i, 1)
    const end = this.now()
    if (slot.logId != null) {
      try {
        await this.host.logEnd(slot.logId, end, (end.getTime() - slot.startedAt.getTime()) / 1000)
      } catch {
        // ignorato
      }
    }
    // In manuale, se un evento è in testa alla coda parte comunque.
    if (
      list === this.slots &&
      !this.stopped &&
      !this.current() &&
      this.mode === 'manual' &&
      this.queue[0]?.origin === 'event'
    ) {
      await this.startNext()
    }
    this.emit()
  }

  private emit(): void {
    if (!this.listeners.size) return
    const s = this.snapshot()
    for (const l of this.listeners) l(s)
  }
}

/**
 * Dopo un riavvio o un blackout: se la regia era in AUTOMATICO riparte in automatico
 * (e quindi riprende a suonare da sola, la radio non resta muta); se era in MANUALE resta in manuale.
 * Da quel momento salva la modalità a ogni cambio (tasto, pannello remoto, evento, STOP).
 * Restituisce la funzione che smette di seguire i cambi.
 */
export function restoreAndPersistMode(
  engine: PlayoutEngine,
  saved: PlayoutMode,
  save: (mode: PlayoutMode) => void
): () => void {
  if (saved === 'auto' && engine.getMode() !== 'auto') engine.setMode('auto')
  let last = saved
  const check = (mode: PlayoutMode): void => {
    if (mode === last) return
    last = mode
    save(mode)
  }
  // cambiata a mano prima che le impostazioni fossero lette
  check(engine.getMode())
  return engine.subscribe((s) => check(s.mode))
}
