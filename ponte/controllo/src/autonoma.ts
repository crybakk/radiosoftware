/**
 * Diretta autonoma: il ponte suona da solo la musica della libreria del server, senza la regia.
 * Si comanda dal pannello (avvia, ferma, coda, salta). Con la coda vuota sceglie a caso,
 * senza ripetere troppo presto lo stesso brano o lo stesso artista.
 *
 * In Liquidsoap c'è sempre al massimo un brano "preparato" oltre a quello in onda:
 * il successivo si decide 20 secondi prima della fine, così la coda resta modificabile.
 */
import type { Library, ServerTrack } from './libreria.ts'
import type { AutoCommand, AutoState, AutoTrack } from './protocol.ts'

export interface LiquidsoapAuto {
  setActive(on: boolean): Promise<boolean>
  push(uri: string): Promise<boolean>
  skip(): Promise<boolean>
}

const PREPARE_BEFORE_END_S = 20
const RECENT_TRACKS = 30
const RECENT_ARTISTS = 6

const pub = (t: ServerTrack): AutoTrack => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration })

/** Valore tra virgolette per "annotate:" di Liquidsoap (virgolette e barre protette, niente a capo). */
const annotateValue = (v: string): string =>
  v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * URI per Liquidsoap, con la correzione di volume e, se ci sono, titolo e artista
 * (metadati che arrivano a Icecast e ai lettori degli ascoltatori).
 */
export function annotate(path: string, gainDb: number, meta?: { title?: string; artist?: string }): string {
  const parts: string[] = []
  if (gainDb) parts.push(`liq_amplify="${gainDb.toFixed(1)} dB"`)
  if (meta?.title) parts.push(`title="${annotateValue(meta.title)}"`)
  if (meta?.artist) parts.push(`artist="${annotateValue(meta.artist)}"`)
  return parts.length ? `annotate:${parts.join(',')}:${path}` : path
}

export class AutonomousPlayer {
  private active = false
  private onAir: (ServerTrack & { startedAt: number }) | null = null
  private prepared: ServerTrack | null = null
  private queue: (ServerTrack & { uid: string })[] = []
  private history: ServerTrack[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private seq = 0
  onChange: (s: AutoState) => void = () => {}
  /** Avviata o fermata, e da chi. */
  onActive: (on: boolean, by: string) => void = () => {}
  /** Un brano della diretta autonoma è andato in onda (per il registro). */
  onPlay: (t: ServerTrack) => void = () => {}
  /**
   * Annuncio da mettere prima del prossimo brano (voce sintetica), se ce n'è uno.
   * airsAt = quando andrà in onda: la voce si produce adesso e dice l'ora di quel momento.
   */
  interject: (airsAt: Date) => Promise<{ id: string; title: string; seconds: number } | null> = async () => null
  /** Brani dati alla riserva e non ancora partiti (Liquidsoap li tiene pronti), in ordine. */
  private reserveQueued: { path: string; seconds: number }[] = []
  /** Quando finisce il brano della riserva in onda adesso (null = la riserva non suona). */
  private reserveEndsAt: number | null = null
  private readonly lib: Library
  private readonly lq: LiquidsoapAuto
  private readonly now: () => number

  constructor(lib: Library, lq: LiquidsoapAuto, now: () => number = () => Date.now()) {
    this.lib = lib
    this.lq = lq
    this.now = now
  }

  state(): AutoState {
    return {
      active: this.active,
      onAir: this.onAir ? { ...pub(this.onAir), startedAt: new Date(this.onAir.startedAt).toISOString() } : null,
      prepared: this.prepared ? pub(this.prepared) : null,
      queue: this.queue.map((t) => ({ ...pub(t), uid: t.uid })),
      libraryCount: this.lib.count()
    }
  }

  async run(cmd: AutoCommand, by = ''): Promise<unknown> {
    switch (cmd.type) {
      case 'search':
        // ricerca vuota = sfoglia la libreria: più brani, in ordine alfabetico
        return this.lib.search(String(cmd.q ?? ''), String(cmd.q ?? '').trim() ? 50 : 200).map(pub)
      case 'start':
        return this.start(by)
      case 'stop':
        return this.stop(by)
      case 'skip':
        if (!this.active) throw new Error('la diretta autonoma non è attiva')
        if (!this.prepared) await this.prepareNext(this.now())
        if (!(await this.lq.skip())) throw new Error('il mixer del ponte non risponde')
        return null
      case 'enqueue': {
        const t = this.lib.get(String(cmd.id))
        if (!t) throw new Error('brano non trovato sul server')
        const item = { ...t, uid: `a${++this.seq}` }
        if (cmd.where === 'next') this.queue.unshift(item)
        else this.queue.push(item)
        this.emit()
        return null
      }
      case 'remove':
        this.queue = this.queue.filter((t) => t.uid !== cmd.uid)
        this.emit()
        return null
      default:
        throw new Error('comando sconosciuto')
    }
  }

  private starting: Promise<null> | null = null
  private preparing: Promise<void> | null = null

  /** Doppio clic su "avvia": un solo avvio (un solo brano mandato al mixer, un solo avviso). */
  private start(by: string): Promise<null> {
    this.starting ??= this.doStart(by).finally(() => (this.starting = null))
    return this.starting
  }

  private async doStart(by: string): Promise<null> {
    if (this.active) return null
    if (!this.lib.count()) throw new Error('la libreria del server è vuota')
    // prima il brano, poi l'interruttore: così si sente subito musica
    await this.prepareNext(this.now())
    if (!(await this.lq.setActive(true))) {
      this.prepared = null
      throw new Error('il mixer del ponte non risponde')
    }
    this.active = true
    this.reserveEndsAt = null
    this.onActive(true, by)
    this.emit()
    return null
  }

  private async stop(by: string): Promise<null> {
    if (!this.active) return null
    this.active = false
    this.clearTimer()
    // il brano preparato torna in testa alla coda, per non perderlo
    if (this.prepared) this.queue.unshift({ ...this.prepared, uid: `a${++this.seq}` })
    this.prepared = null
    this.onAir = null
    await this.lq.setActive(false)
    this.onActive(false, by)
    this.emit()
    return null
  }

  /** Liquidsoap avvisa che è partito un brano della diretta autonoma. */
  onTrackStart(file: string): void {
    if (!this.active) return
    const t =
      this.prepared && this.lib.path(this.prepared) === file
        ? this.prepared
        : this.lib.all().find((x) => this.lib.path(x) === file)
    if (!t) return
    if (this.prepared?.id === t.id) this.prepared = null
    this.onAir = { ...t, startedAt: this.now() }
    this.onPlay(t)
    this.history.push(t)
    if (this.history.length > RECENT_TRACKS) this.history.shift()
    this.clearTimer()
    const wait = t.duration > 0 ? Math.max(0, t.duration - PREPARE_BEFORE_END_S) : 0
    // il prossimo parte alla fine di questo: un annuncio dirà l'ora di quel momento
    const endsAt = this.onAir.startedAt + Math.max(0, t.duration) * 1000
    this.timer = setTimeout(() => void this.prepareNext(endsAt).catch(() => {}), wait * 1000)
    this.emit()
  }

  /** Brano "virtuale" per un annuncio (il file è nella cartella della musica, fuori dalla libreria). */
  private async announce(airsAt: number): Promise<ServerTrack | null> {
    let j: Awaited<ReturnType<AutonomousPlayer['interject']>> = null
    try {
      j = await this.interject(new Date(Math.max(this.now(), airsAt)))
    } catch {
      // senza annuncio si va avanti con la musica
    }
    return j ? { id: j.id, title: j.title, artist: 'Annuncio vocale', duration: j.seconds, bitrate: 128, gainDb: 0, mtime: 0, size: 0 } : null
  }

  /** Una preparazione alla volta (timer di fine brano e "salta" insieme): mai due brani nel mixer. */
  private prepareNext(airsAt: number): Promise<void> {
    this.preparing ??= this.doPrepareNext(airsAt).finally(() => (this.preparing = null))
    return this.preparing
  }

  private async doPrepareNext(airsAt: number): Promise<void> {
    if (this.prepared) return
    // i brani in coda tolti dalla libreria nel frattempo (eliminati, spostati) si saltano:
    // Liquidsoap non li troverebbe e la diretta resterebbe muta
    const announce = await this.announce(airsAt)
    let queued: (ServerTrack & { uid: string }) | undefined
    while (!announce && !queued && this.queue.length) {
      const q = this.queue.shift()!
      const cur = this.lib.get(q.id)
      if (cur) queued = { ...cur, uid: q.uid }
    }
    const next =
      announce ??
      queued ??
      this.lib.pickRandom(
        this.history.map((t) => t.id),
        this.history.slice(-RECENT_ARTISTS).map((t) => t.artist)
      )
    if (!next) throw new Error('nessun brano disponibile sul server')
    if (!(await this.lq.push(annotate(this.lib.path(next), next.gainDb, announce ? undefined : next)))) {
      if ('uid' in next) this.queue.unshift(next as ServerTrack & { uid: string })
      throw new Error('il mixer del ponte non risponde')
    }
    this.prepared = next
    this.emit()
  }

  /**
   * Riserva del ponte: brano a caso per le uscite che non devono mai restare mute
   * (Icecast esterno, dirette video) quando non c'è né regia né diretta autonoma.
   * Usa la stessa memoria dei brani recenti, così non si ripetono artisti.
   * Liquidsoap chiede il brano successivo appena ne parte uno: quello che si dà adesso andrà in onda
   * alla fine del brano dato la volta prima (se la riserva sta suonando), altrimenti subito.
   */
  async nextReserve(): Promise<string | null> {
    // quello che si dà adesso parte dopo il brano in onda e dopo quelli già dati e non ancora partiti
    const now = this.now()
    const base = this.reserveEndsAt !== null && this.reserveEndsAt > now ? this.reserveEndsAt : now
    const a = await this.announce(base + this.reserveQueued.reduce((n, q) => n + Math.max(0, q.seconds), 0) * 1000)
    if (a) {
      this.reserveGiven(this.lib.path(a), a.duration)
      return this.lib.path(a)
    }
    const t = this.lib.pickRandom(
      this.history.map((x) => x.id),
      this.history.slice(-RECENT_ARTISTS).map((x) => x.artist)
    )
    if (!t) return null
    this.reserveGiven(this.lib.path(t), t.duration)
    this.history.push(t)
    if (this.history.length > RECENT_TRACKS) this.history.shift()
    return annotate(this.lib.path(t), t.gainDb, t)
  }

  private reserveGiven(path: string, seconds: number): void {
    this.reserveQueued.push({ path, seconds })
    // Liquidsoap ne tiene pronti al massimo un paio: quelli più vecchi sono stati scartati
    if (this.reserveQueued.length > 3) this.reserveQueued.shift()
  }

  /** Liquidsoap avvisa che è partito un brano della riserva (il file, come l'ha avuto). */
  onReserveStart(file: string): void {
    const i = this.reserveQueued.findIndex((q) => q.path === file)
    const seconds = i >= 0 ? this.reserveQueued[i].seconds : (this.lib.all().find((x) => this.lib.path(x) === file)?.duration ?? 0)
    if (i >= 0) this.reserveQueued.splice(0, i + 1)
    this.reserveEndsAt = seconds > 0 ? this.now() + seconds * 1000 : null
  }

  /** La riserva è uscita di onda (è tornata la regia o un'esterna): il brano a metà si scarta. */
  reserveStopped(): void {
    this.reserveEndsAt = null
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private emit(): void {
    this.onChange(this.state())
  }
}
