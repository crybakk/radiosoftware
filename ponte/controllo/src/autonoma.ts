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

/** URI per Liquidsoap, con la correzione di volume. */
export function annotate(path: string, gainDb: number): string {
  return gainDb ? `annotate:liq_amplify="${gainDb.toFixed(1)} dB":${path}` : path
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
  /** Annuncio da mettere prima del prossimo brano (voce sintetica), se ce n'è uno. */
  interject: () => { id: string; title: string; seconds: number } | null = () => null
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
        return this.lib.search(String(cmd.q ?? '')).map(pub)
      case 'start':
        return this.start(by)
      case 'stop':
        return this.stop(by)
      case 'skip':
        if (!this.active) throw new Error('la diretta autonoma non è attiva')
        if (!this.prepared) await this.prepareNext()
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

  private async start(by: string): Promise<null> {
    if (this.active) return null
    if (!this.lib.count()) throw new Error('la libreria del server è vuota')
    // prima il brano, poi l'interruttore: così si sente subito musica
    await this.prepareNext()
    if (!(await this.lq.setActive(true))) {
      this.prepared = null
      throw new Error('il mixer del ponte non risponde')
    }
    this.active = true
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
    this.timer = setTimeout(() => void this.prepareNext().catch(() => {}), wait * 1000)
    this.emit()
  }

  /** Brano "virtuale" per un annuncio (il file è nella cartella della musica, fuori dalla libreria). */
  private announce(): ServerTrack | null {
    const j = this.interject()
    return j ? { id: j.id, title: j.title, artist: 'Annuncio vocale', duration: j.seconds, bitrate: 128, gainDb: 0, mtime: 0, size: 0 } : null
  }

  private async prepareNext(): Promise<void> {
    if (this.prepared) return
    const next =
      this.announce() ??
      this.queue.shift() ??
      this.lib.pickRandom(
        this.history.map((t) => t.id),
        this.history.slice(-RECENT_ARTISTS).map((t) => t.artist)
      )
    if (!next) throw new Error('nessun brano disponibile sul server')
    if (!(await this.lq.push(annotate(this.lib.path(next), next.gainDb)))) {
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
   */
  nextReserve(): string | null {
    const a = this.announce()
    if (a) return this.lib.path(a)
    const t = this.lib.pickRandom(
      this.history.map((x) => x.id),
      this.history.slice(-RECENT_ARTISTS).map((x) => x.artist)
    )
    if (!t) return null
    this.history.push(t)
    if (this.history.length > RECENT_TRACKS) this.history.shift()
    return annotate(this.lib.path(t), t.gainDb)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private emit(): void {
    this.onChange(this.state())
  }
}
