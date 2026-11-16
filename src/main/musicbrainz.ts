/**
 * Ricerca su MusicBrainz dei dati mancanti per il report SIAE e dei generi (per le rotazioni),
 * in background, un brano alla volta.
 * Parte solo quando lo chiedi (sono circa due richieste al secondo per brano e il 4G non è illimitato)
 * e si può fermare: riprende da dove era rimasta.
 */
import type { RadioDb } from '../core/db'
import { MbError, MusicBrainz, type MbResult } from '../core/musicbrainz'
import type { Track } from '../core/types'
import type { AcoustId } from '../core/acoustid'
import { fingerprint } from './fpcalc'

export interface MbStatus {
  running: boolean
  /** Brani ancora da cercare. */
  todo: number
  /** Brani già cercati e quanti trovati. */
  checked: number
  found: number
  /** Ricerca dall'audio con AcoustID attiva. */
  acoustId: boolean
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
    mb?: MusicBrainz,
    /** Ricerca dall'audio per i brani non trovati per titolo (se c'è la chiave e fpcalc). */
    private readonly acoustId?: { client: AcoustId; enabled: () => boolean; fpcalc: () => string | null }
  ) {
    this.mb = mb ?? new MusicBrainz()
  }

  private acoustIdOn(): boolean {
    return !!this.acoustId?.enabled() && !!this.acoustId.fpcalc()
  }

  status(): MbStatus {
    return {
      running: this.running,
      ...this.db.mbStats(this.acoustIdOn()),
      acoustId: this.acoustIdOn(),
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

  /** Cerca subito pochi brani precisi (per esempio appena scaricati dal server), anche senza la ricerca completa. */
  async lookup(ids: number[]): Promise<void> {
    if (this.running) return // la ricerca completa li troverà (sono tornati in coda)
    for (const id of ids) {
      const t = this.db.getTrack(id)
      if (!t) continue
      try {
        await this.one(t)
      } catch {
        // resta in coda per la prossima ricerca
      }
    }
    this.emit(true)
  }

  /**
   * Un brano: se la registrazione è già stata trovata basta rileggerla (generi); se era già stata
   * cercata senza trovarla non si ricerca; altrimenti ricerca completa. Se la registrazione non ha generi
   * si prendono quelli del primo artista (letti una volta sola per artista).
   */
  private async one(t: Track & { recordingId?: string; checked?: boolean; acoustIdTried?: boolean }, signal?: AbortSignal): Promise<void> {
    let r: MbResult | null = null
    if (t.recordingId) r = await this.mb.recording(t.recordingId, signal)
    else if (!t.checked) r = await this.mb.find(t, signal)
    // non trovato per titolo: si prova dall'audio (una volta sola per brano)
    if (!r && !t.recordingId && !t.acoustIdTried && this.acoustIdOn()) {
      let fp: { fingerprint: string; duration: number } | null = null
      try {
        fp = await fingerprint(this.acoustId!.fpcalc()!, t.path, signal)
      } catch {
        // file illeggibile o mancante: non si riprova
      }
      const id = fp ? await this.acoustId!.client.recording(fp, signal) : null
      if (id) r = await this.mb.recording(id, signal)
      this.db.markAcoustId(t.id)
    }
    let genres = r?.genres ?? []
    const artist = r?.artistIds[0]
    if (r && !genres.length && artist) {
      const known = this.db.mbArtistGenres(artist)
      if (known) genres = known
      else {
        genres = await this.mb.artistGenres(artist, signal)
        this.db.saveMbArtistGenres(artist, genres)
      }
    }
    this.db.saveMb(t.id, r?.recordingId ?? '', { ...(r ?? {}), genres })
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
        const batch = this.db.mbPending(20, this.acoustIdOn())
        if (!batch.length) break
        for (const t of batch) {
          if (ac.signal.aborted) break
          this.current = `${t.artist} - ${t.title}`
          this.emit()
          try {
            await this.one(t, ac.signal)
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
