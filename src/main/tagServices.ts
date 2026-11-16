/**
 * Ricerca in background dei generi su Discogs e delle etichette su Last.fm, un brano alla volta,
 * con la chiave scritta nelle impostazioni. Come MusicBrainz: parte quando lo chiedi, si ferma e riprende.
 */
import type { RadioDb } from '../core/db'
import { Discogs } from '../core/discogs'
import { LastFm } from '../core/lastfm'
import type { Track } from '../core/types'
import { ServiceError } from '../core/webLimit'

export type TagService = 'dc' | 'lfm'

export interface TagStatus {
  service: TagService
  name: string
  /** C'è la chiave nelle impostazioni. */
  configured: boolean
  running: boolean
  todo: number
  checked: number
  found: number
  current: string
  lastError: string | null
  doneNow: number
}

type Lookup = (t: Track, signal: AbortSignal) => Promise<string[]>

export class TagWorker {
  private running = false
  private abort: AbortController | null = null
  private current = ''
  private lastError: string | null = null
  private doneNow = 0
  private lastEmit = 0

  constructor(
    private readonly db: RadioDb,
    readonly service: TagService,
    private readonly name: string,
    private readonly configured: () => boolean,
    private readonly lookup: Lookup,
    private readonly onStatus: (s: TagStatus) => void
  ) {}

  status(): TagStatus {
    return {
      service: this.service,
      name: this.name,
      configured: this.configured(),
      running: this.running,
      ...this.db.tagStats(this.service),
      current: this.current,
      lastError: this.lastError,
      doneNow: this.doneNow
    }
  }

  private emit(force = false): void {
    if (!force && Date.now() - this.lastEmit < 1000) return
    this.lastEmit = Date.now()
    this.onStatus(this.status())
  }

  stop(): void {
    this.abort?.abort()
  }

  retry(): TagStatus {
    if (!this.running) this.db.tagRetry(this.service)
    return this.status()
  }

  async start(): Promise<void> {
    if (this.running) return
    if (!this.configured()) {
      this.lastError = `manca la chiave di ${this.name} nelle impostazioni`
      this.emit(true)
      return
    }
    this.running = true
    this.lastError = null
    this.doneNow = 0
    const ac = new AbortController()
    this.abort = ac
    this.emit(true)
    let failures = 0
    try {
      while (!ac.signal.aborted) {
        const batch = this.db.tagPending(this.service, 20)
        if (!batch.length) break
        for (const t of batch) {
          if (ac.signal.aborted) break
          this.current = `${t.artist} - ${t.title}`
          this.emit()
          try {
            this.db.saveTags(this.service, t.id, await this.lookup(t, ac.signal))
            this.doneNow++
            failures = 0
          } catch (e) {
            if (ac.signal.aborted) break
            this.lastError = e instanceof Error ? e.message : String(e)
            // chiave sbagliata: inutile continuare; rete o servizio in difficoltà: dopo 5 errori di fila
            if (/chiave/.test(this.lastError) || ++failures >= 5) throw new ServiceError(this.lastError)
          }
          this.emit()
        }
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
    } finally {
      this.running = false
      this.abort = null
      this.current = ''
      this.emit(true)
    }
  }
}

/** I due servizi con le chiavi lette dalle impostazioni a ogni richiesta. */
export function tagWorkers(db: RadioDb, onStatus: (s: TagStatus) => void, deps: { discogs?: Discogs; lastfm?: LastFm } = {}): TagWorker[] {
  const settings = () => db.getSettings()
  const discogs = deps.discogs ?? new Discogs(() => settings().discogsToken.trim())
  const lastfm = deps.lastfm ?? new LastFm(() => settings().lastfmKey.trim())
  return [
    new TagWorker(db, 'dc', 'Discogs', () => !!settings().discogsToken.trim(), async (t, signal) => (await discogs.genres(t, signal)) ?? [], onStatus),
    new TagWorker(
      db,
      'lfm',
      'Last.fm',
      () => !!settings().lastfmKey.trim(),
      async (t, signal) => {
        const tags = t.title.trim() && t.artist.trim() ? await lastfm.trackTags(t, signal) : []
        if (tags.length || !t.artist.trim()) return tags
        // il brano non ha etichette: quelle dell'artista, lette una volta sola per artista
        const known = db.lfmArtistTags(t.artist)
        if (known) return known
        const a = await lastfm.artistTags(t.artist, signal)
        db.saveLfmArtistTags(t.artist, a)
        return a
      },
      onStatus
    )
  ]
}
