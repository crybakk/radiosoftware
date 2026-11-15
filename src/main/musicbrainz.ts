/**
 * Ricerca su MusicBrainz dei dati mancanti per il report SIAE, in background, un brano alla volta.
 * Parte solo quando lo chiedi (sono circa due richieste al secondo per brano e il 4G non è illimitato)
 * e si può fermare: riprende da dove era rimasta.
 */
import type { RadioDb } from '../core/db'
import { MbError, MusicBrainz } from '../core/musicbrainz'

export interface MbStatus {
  running: boolean
  /** Brani ancora da cercare. */
  todo: number
  /** Brani già cercati e quanti trovati. */
  checked: number
  found: number
  current: string
  lastError: string | null
  /** Brani completati in questa sessione di ricerca. */
  doneNow: number
}

export class MusicBrainzService {
  private running = false
  private abort: AbortController | null = null
  private current = ''
  private lastError: string | null = null
  private doneNow = 0
  private lastEmit = 0
  private readonly mb: MusicBrainz

  constructor(
    private readonly db: RadioDb,
    private readonly onStatus: (s: MbStatus) => void,
    mb?: MusicBrainz
  ) {
    this.mb = mb ?? new MusicBrainz()
  }

  status(): MbStatus {
    return {
      running: this.running,
      ...this.db.mbStats(),
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

  /** Rimette in coda i brani già cercati che sono ancora incompleti (per esempio dopo mesi). */
  retry(): MbStatus {
    if (!this.running) this.db.mbRetry()
    return this.status()
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.lastError = null
    this.doneNow = 0
    const ac = new AbortController()
    this.abort = ac
    this.emit(true)
    let failures = 0
    try {
      while (!ac.signal.aborted) {
        const batch = this.db.mbPending(20)
        if (!batch.length) break
        for (const t of batch) {
          if (ac.signal.aborted) break
          this.current = `${t.artist} - ${t.title}`
          this.emit()
          try {
            const r = await this.mb.find(t, ac.signal)
            this.db.saveMb(t.id, r?.recordingId ?? '', r ?? {})
            this.doneNow++
            failures = 0
          } catch (e) {
            if (ac.signal.aborted) break
            // rete assente o MusicBrainz in difficoltà: dopo 5 errori di fila ci si ferma
            this.lastError = e instanceof MbError ? e.message : 'errore nella ricerca su MusicBrainz'
            if (++failures >= 5) throw new MbError(this.lastError)
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
