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
  /** Brano associato a un evento. */
  resolveTrack(id: number): Promise<Track | null>
}

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
  private starting = false
  private filling = false
  private lastError: string | null = null
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
    this.emit()
  }

  getMode(): PlayoutMode {
    return this.mode
  }

  /** Avvia il primo brano in coda se non c'è nulla in onda. */
  async play(): Promise<void> {
    if (!this.current()) await this.startNext()
  }

  /** Sfuma il brano in onda e passa subito al successivo. */
  async next(): Promise<void> {
    const cur = this.current()
    if (cur) this.fade(cur, this.options.crossfadeSeconds)
    await this.startNext()
  }

  /** Ferma tutto con una breve sfumatura e passa in manuale. */
  stop(): void {
    this.mode = 'manual'
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
    this.emit()
  }

  /** Suona un jingle dalla cartwall, sopra a quello che è in onda. */
  async playCart(track: Track): Promise<void> {
    const item: QueueItem = { uid: newUid(), track, origin: 'manual' }
    const slot = await this.launch(item, this.carts)
    if (!slot) this.emit()
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
    const due = dueEvents(this.events, this.lastEventCheck, now)
    this.lastEventCheck = now
    let hardEvent = false
    let insertAt = 0
    while (insertAt < this.queue.length && this.queue[insertAt].origin === 'event') insertAt++
    for (const { event } of due) {
      const track = await this.host.resolveTrack(event.trackId)
      if (!track) {
        this.lastError = `Evento "${event.label || event.time}": brano non trovato`
        continue
      }
      this.queue.splice(insertAt++, 0, { uid: newUid(), track, origin: 'event' })
      if (event.mode === 'hard') hardEvent = true
    }
    if (hardEvent) await this.next()

    // 2. passaggio al brano successivo al punto di mix
    const cur = this.current()
    if (cur && !cur.mixTriggered && !cur.fading) {
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
      for (let attempt = 0; attempt < 3 && this.queue.length; attempt++) {
        const item = this.queue.shift()!
        const slot = await this.launch(item, this.slots)
        if (slot) break
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
    try {
      await player.start()
    } catch (err) {
      this.lastError = `Impossibile riprodurre "${item.track.artist} - ${item.track.title}": ${
        err instanceof Error ? err.message : String(err)
      }`
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
    if (list === this.slots && !this.current() && this.mode === 'manual' && this.queue[0]?.origin === 'event') {
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
