import { DEFAULT_MAX_STRETCH, describePlan, isShowy, planTransition, type MixDecision, type MixPlan, type MixStyle } from './djMix'
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
  /**
   * Mix DJ (facoltativo): avvia `to` agganciato al battito di `from` secondo il piano e prepara l'uscita di `from`
   * (bassi, loop, sfumatura): `from` finisce da solo alla fine del mix. Rifiuta se non si può (si torna al cambio normale).
   */
  startMix?(from: Player, to: Player, plan: MixPlan): Promise<void>
}

/**
 * Secondi di anticipo con cui si prepara il Mix DJ: c'è da misurare dove si trova davvero il brano che esce
 * (un paio di secondi) e poi far partire quello che entra dall'inizio del file, senza volume.
 */
export const DJ_LEAD_SECONDS = 8

/** Sovrapposizione minima tra due canzoni nei cambi automatici (secondi). */
export const MIN_MUSIC_OVERLAP_SECONDS = 4

/** Anticipo del Mix DJ per questo piano: in più il tratto di B prima del punto da cui entra (al massimo 20 s). */
export function djLeadSeconds(plan: MixPlan): number {
  return DJ_LEAD_SECONDS + Math.min(20, Math.max(0, plan.bStart - plan.bIn) / Math.max(0.5, plan.rate))
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
  /** Mix DJ acceso per tutti i cambi automatici (impostato dagli eventi). */
  djMix?: boolean
  /** Variazione massima di velocità nel Mix DJ (0.06 = ±6%). */
  djMaxStretch?: number
  /** Passaggi permessi nel Mix DJ (assente = tutti). */
  djStyles?: MixStyle[]
}

/** Stato del Mix DJ per l'interfaccia. */
export interface DjState {
  /** Acceso per tutti i cambi automatici. */
  always: boolean
  /** Acceso per il prossimo cambio soltanto. */
  once: boolean
  /** Passaggio scelto dalla regia per il prossimo cambio (null = lo sceglie la regia da sola). */
  style: MixStyle | null
  /** Il prossimo cambio: Mix DJ possibile o motivo per cui sarà una dissolvenza. null = niente in coda. */
  next: { ok: boolean; text: string } | null
  /** Un Mix DJ è in corso. */
  mixing: boolean
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
  dj: DjState
}

interface Slot {
  item: QueueItem
  player: Player
  logId: number | null
  startedAt: Date
  mixTriggered: boolean
  fading: boolean
  ended: boolean
  /** Sta uscendo con un Mix DJ: finisce da solo. */
  mixingOut?: boolean
  /** Il Mix DJ non è riuscito: per questo brano vale il cambio normale. */
  noDj?: boolean
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
  /** Mix DJ per il prossimo cambio soltanto (pulsante in regia). */
  private djOnce = false
  /** Passaggio scelto a mano per il prossimo cambio. */
  private djStyle: MixStyle | null = null
  /** Ultimo passaggio fatto e cambi DJ da quello vistoso più recente (per variare). */
  private djLast: MixStyle | null = null
  private djSinceShowy = Infinity

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

  /** Mix DJ per il solo prossimo cambio (si spegne da solo dopo il cambio), con un passaggio scelto o automatico. */
  setDjOnce(on: boolean, style: MixStyle | null = null): void {
    this.djOnce = on
    this.djStyle = on ? style : null
    this.emit()
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
      const dj = this.djPlan(cur)
      if (dj?.ok && pos >= dj.plan.aStart - djLeadSeconds(dj.plan)) {
        cur.mixTriggered = true
        await this.startDjMix(cur, dj.plan)
      } else if (!dj?.ok && pos >= this.mixPoint(cur.item.track)) {
        cur.mixTriggered = true
        if (this.mode === 'auto' || this.queue[0]?.origin === 'event') {
          // un cambio senza effetti conta per il prossimo passaggio vistoso del Mix DJ
          if (this.djWanted()) this.djSinceShowy++
          await this.startNext()
          // sfumatura incrociata: la canzone che esce sfuma fino alla sua fine mentre entra la successiva
          if (cur.item.track.kind === 'music' && this.current() !== cur) {
            this.fade(cur, Math.max(0.5, this.endPoint(cur.item.track) - cur.player.position()))
          }
        }
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
    const cur = this.current()
    const djNow = cur && !cur.mixTriggered ? this.djPlan(cur) : null
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
          toMix: Math.max(0, (s === cur && djNow?.ok ? djNow.plan.aStart : this.mixPoint(s.item.track)) - pos),
          fading: s.fading || !!s.mixingOut
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
      lastError: this.lastError,
      dj: this.djState()
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
      if (!s.ended && !s.fading && !s.mixingOut) return s
    }
    return undefined
  }

  /** Il prossimo cambio sarà un Mix DJ? Solo dove il cambio avviene da solo, o se l'ha chiesto la regia. */
  private djWanted(): boolean {
    const next = this.queue[0]
    if (!next || !this.backend.startMix) return false
    if (this.djOnce) return true
    return !!this.options.djMix && (this.mode === 'auto' || next.origin === 'event')
  }

  /** Piano del Mix DJ dal brano in onda al primo in coda; null se il Mix DJ non è richiesto. */
  private djPlan(cur: Slot): MixDecision | null {
    if (cur.noDj || !this.djWanted()) return null
    const d = planTransition(cur.item.track, this.queue[0].track, {
      maxStretch: this.options.djMaxStretch ?? DEFAULT_MAX_STRETCH,
      allowed: this.options.djStyles,
      force: this.djOnce ? this.djStyle : null,
      sinceShowy: this.djSinceShowy,
      last: this.djLast
    })
    // il punto del mix è già passato (Mix DJ chiesto all'ultimo momento): cambio normale
    if (d.ok && cur.player.position() > d.plan.aStart - 0.5) return { ok: false, reason: 'chiesto troppo tardi per questo brano' }
    return d
  }

  private djState(): DjState {
    const cur = this.current()
    let next: DjState['next'] = null
    if (this.queue[0] && (this.djOnce || this.options.djMix)) {
      const d = cur && !cur.mixTriggered ? this.djPlan(cur) : null
      if (d?.ok) next = { ok: true, text: describePlan(d.plan) }
      else if (d) next = { ok: false, text: `Dissolvenza normale: ${d.reason}` }
      else if (cur && !this.djWanted()) next = { ok: false, text: 'In manuale il Mix DJ vale solo con "Mixa il prossimo"' }
    }
    return {
      always: !!this.options.djMix,
      once: this.djOnce,
      style: this.djOnce ? this.djStyle : null,
      next,
      mixing: this.slots.some((s) => s.mixingOut && !s.ended)
    }
  }

  /** Avvia il Mix DJ; se non riesce il brano torna in testa alla coda e vale il cambio normale. */
  private async startDjMix(cur: Slot, plan: MixPlan): Promise<void> {
    if (this.starting || !this.backend.startMix) return
    this.starting = true
    const gen = this.generation
    const item = this.queue.shift()!
    try {
      this.eventDeadlines.delete(item.uid)
      const slot = await this.launch(item, this.slots, (p) => this.backend.startMix!(cur.player, p, plan))
      if (slot) {
        cur.mixingOut = true
        this.djOnce = false
        this.djStyle = null
        this.djLast = plan.style
        this.djSinceShowy = isShowy(plan.style) ? 0 : this.djSinceShowy + 1
      } else if (gen === this.generation) {
        this.queue.unshift(item)
        cur.noDj = true
        cur.mixTriggered = false
        if (this.lastError) this.lastError = `Mix DJ non riuscito, cambio normale (${this.lastError})`
      } else {
        this.queue.unshift(item)
      }
    } finally {
      this.starting = false
      this.emit()
    }
  }

  /**
   * Dove parte il brano successivo. Le canzoni si sovrappongono sempre almeno MIN_MUSIC_OVERLAP_SECONDS, anche
   * quelle che finiscono secche (punto di mix = fine) o non ancora analizzate: niente "una in coda all'altra".
   */
  private mixPoint(t: Track): number {
    const end = this.endPoint(t)
    const at = t.mixPoint > t.cueIn ? t.mixPoint : end
    if (t.kind !== 'music') return at
    return Math.max(t.cueIn, Math.min(at, end - MIN_MUSIC_OVERLAP_SECONDS))
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
    return this.etasAndEnd().slice(0, -1)
  }

  /** Come etas(), con in fondo l'orario stimato di fine dell'ultimo brano in coda. */
  private etasAndEnd(): Date[] {
    const now = this.now().getTime()
    const cur = this.current()
    let t = now
    if (cur) {
      const dj = cur.mixTriggered ? null : this.djPlan(cur)
      const at = dj?.ok ? dj.plan.aStart : this.mixPoint(cur.item.track)
      t += Math.max(0, at - cur.player.position()) * 1000
    }
    const out = this.queue.map((q) => {
      const at = new Date(t)
      t += airTime(q.track) * 1000
      return at
    })
    out.push(new Date(t))
    return out
  }

  /**
   * Quando partirà, più o meno, quello che mette in onda l'evento (stesse regole di runEvent):
   * serve agli annunci con la voce, che dicono l'ora in cui vanno in onda e non quella in cui scatta l'evento.
   */
  eventStartEstimate(event: ScheduledEvent): Date {
    const now = this.now()
    if (!this.current() || event.mode === 'hard' || event.actions.some((a) => a.type === 'stop')) return now
    // i brani dell'evento vanno dopo quelli degli eventi già in coda (o in testa, se l'evento svuota la coda)
    const clears = event.actions.some((a) => a.type === 'clear' || (a.type === 'playlist' && a.placement === 'replace'))
    let insertAt = 0
    if (!clears) while (insertAt < this.queue.length && this.queue[insertAt].origin === 'event') insertAt++
    let at = this.etasAndEnd()[insertAt].getTime()
    if (event.toleranceSeconds > 0) at = Math.min(at, now.getTime() + event.toleranceSeconds * 1000)
    return new Date(Math.max(now.getTime(), at))
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

  private async launch(
    item: QueueItem,
    list: Slot[],
    start: (p: Player) => Promise<void> = (p) => p.start()
  ): Promise<Slot | null> {
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
      await start(player)
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
