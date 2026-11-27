import { ANALYSIS_TIMEOUT_MS, analyzeFile } from '../core/analyzer'
import { fingerprintFile } from '../core/fingerprintFile'
import { secondiApplausi } from '../core/liveAudio'
import { DjAnalyzer, DjWorkerError, decodeMono } from './djAnalyzer'
import type { RadioDb } from '../core/db'
import { scanLibrary, type ScanProgress } from '../core/scanner'
import type { LibraryStatus } from '../shared/api'

/**
 * Gestisce scansione e analisi in background, un file alla volta,
 * per non togliere risorse alla messa in onda.
 */
export class LibraryService {
  private scanning: ScanProgress | null = null
  private analyzing = false
  private fingerprinting = false
  private liveChecking = false
  private djRunning = false
  private dj: DjAnalyzer | null
  private stopRequested = false
  private abort: AbortController | null = null
  private listeners = new Set<(s: LibraryStatus) => void>()

  constructor(
    private db: RadioDb,
    private ffmpegPath: string | null,
    djWorkerUrl?: URL,
    /** Errori gravi (registro della regia). */
    private log: (riga: string) => void = () => {}
  ) {
    this.dj = djWorkerUrl ? new DjAnalyzer(djWorkerUrl) : null
  }

  onStatus(cb: (s: LibraryStatus) => void): void {
    this.listeners.add(cb)
  }

  status(): LibraryStatus {
    const fp = this.db.fingerprintStats()
    return {
      ...this.db.libraryStats(),
      scanning: this.scanning,
      analyzing: this.analyzing,
      fingerprints: fp.done,
      fingerprintTotal: fp.total,
      fingerprinting: this.fingerprinting,
      ...(() => {
        const l = this.db.liveStats()
        return { liveChecked: l.done, liveTotal: l.total, liveChecking: this.liveChecking }
      })(),
      ...this.djStatus()
    }
  }

  private emit(): void {
    const s = this.status()
    for (const l of this.listeners) l(s)
  }

  async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = { folder: '', seen: 0, added: 0, updated: 0, errors: 0, disabled: 0, done: false }
    this.emit()
    try {
      await scanLibrary(this.db, (p) => {
        this.scanning = p
        this.emit()
      })
    } finally {
      this.scanning = null
      this.emit()
    }
    void this.analyzeAll()
  }

  /** Analizza tutti i brani non ancora analizzati. */
  async analyzeAll(): Promise<void> {
    if (this.analyzing || !this.ffmpegPath) return
    this.analyzing = true
    this.stopRequested = false
    const abort = (this.abort = new AbortController())
    this.emit()
    let lastEmit = 0
    try {
      for (;;) {
        const batch = this.db.pendingAnalysis(20)
        if (!batch.length || this.stopRequested) break
        for (const t of batch) {
          if (this.stopRequested) break
          try {
            // tempo massimo: 60 s o tre volte la durata del brano
            const timeout = Math.max(ANALYSIS_TIMEOUT_MS, 3 * t.duration * 1000)
            const r = await analyzeFile(this.ffmpegPath, t.path, abort.signal, timeout)
            this.db.saveAnalysis(t.id, r)
          } catch {
            // analisi interrotta da stop(): il brano resta da analizzare
            if (abort.signal.aborted) break
            if (!(t.duration > 0)) {
              // né i tag né ffmpeg sanno quanto dura: non è un brano da mandare in onda.
              // Viene disabilitato come un file sparito, una nuova scansione lo riprova.
              this.db.markMissing(t.id)
              continue
            }
            // file illeggibile: lo segniamo come analizzato con i dati del tag, per non riprovarlo all'infinito
            this.db.saveAnalysis(t.id, {
              duration: t.duration,
              loudness: null,
              cueIn: 0,
              cueOut: t.duration,
              mixPoint: t.duration
            })
          }
          if (Date.now() - lastEmit > 1000) {
            lastEmit = Date.now()
            this.emit()
          }
        }
      }
    } finally {
      if (this.abort === abort) this.abort = null
      this.analyzing = false
      this.emit()
    }
    await this.fingerprintAll()
  }

  /**
   * Impronte audio della musica (per riconoscere i brani nelle dirette esterne), dopo l'analisi.
   * Circa mezzo secondo a brano, un brano alla volta.
   */
  async fingerprintAll(): Promise<void> {
    if (this.fingerprinting || this.analyzing || !this.ffmpegPath) return
    this.fingerprinting = true
    this.stopRequested = false
    this.emit()
    let lastEmit = 0
    try {
      for (;;) {
        const batch = this.db.pendingFingerprint(20)
        if (!batch.length || this.stopRequested) break
        for (const t of batch) {
          if (this.stopRequested) break
          try {
            this.db.saveFingerprint(t.id, await fingerprintFile(this.ffmpegPath, t.path))
          } catch {
            // file illeggibile: niente impronta finché il file non cambia
            this.db.saveFingerprint(t.id, null)
          }
          if (Date.now() - lastEmit > 1000) {
            lastEmit = Date.now()
            this.emit()
          }
        }
      }
    } finally {
      this.fingerprinting = false
      this.emit()
    }
    await this.liveAll()
  }

  /**
   * Live riconosciuti dal suono (applausi all'inizio o alla fine), dopo le impronte.
   * Legge solo i primi e gli ultimi secondi di ogni brano, uno alla volta.
   */
  async liveAll(): Promise<void> {
    if (this.liveChecking || this.fingerprinting || this.analyzing || !this.ffmpegPath) return
    this.liveChecking = true
    this.stopRequested = false
    const abort = (this.abort = new AbortController())
    this.emit()
    let lastEmit = 0
    try {
      for (;;) {
        const batch = this.db.pendingLive(20)
        if (!batch.length || this.stopRequested) break
        for (const t of batch) {
          if (this.stopRequested) break
          try {
            this.db.saveLive(t.id, await secondiApplausi(this.ffmpegPath, t.path, abort.signal))
          } catch {
            if (abort.signal.aborted) break
            // file illeggibile: non si riprova finché il file non cambia
            this.db.saveLive(t.id, null)
          }
          if (Date.now() - lastEmit > 1000) {
            lastEmit = Date.now()
            this.emit()
          }
        }
      }
    } finally {
      if (this.abort === abort) this.abort = null
      this.liveChecking = false
      this.emit()
    }
    await this.djAll()
  }

  private djStatus(): { djDone: number; djTotal: number; djAnalyzing: boolean } {
    const s = this.db.djStats()
    return { djDone: s.done, djTotal: s.total, djAnalyzing: this.djRunning }
  }

  /**
   * Analisi "da DJ" della musica (BPM, battiti, tonalità, energia, intro/outro), dopo i live.
   * Qualche secondo a brano, un brano alla volta, in un thread separato.
   */
  async djAll(): Promise<void> {
    if (!this.dj || this.djRunning || this.liveChecking || this.analyzing || this.fingerprinting || !this.ffmpegPath) return
    this.djRunning = true
    this.stopRequested = false
    const abort = (this.abort = new AbortController())
    this.emit()
    let lastEmit = 0
    let crashes = 0
    try {
      for (;;) {
        const batch = this.db.pendingDj(20)
        if (!batch.length || this.stopRequested) break
        for (const t of batch) {
          if (this.stopRequested) break
          try {
            const pcm = await decodeMono(this.ffmpegPath, t.path, abort.signal)
            this.db.saveDj(t.id, await this.dj.analyze(pcm, t.cueIn, t.cueOut))
            crashes = 0
          } catch (err) {
            if (abort.signal.aborted) break
            if (err instanceof DjWorkerError) {
              // il thread di analisi non parte: il brano resta da analizzare (non è "senza ritmo")
              if (++crashes >= 3) {
                this.log(`analisi per il Mix DJ ferma: il thread di analisi non parte (${err.message})`)
                this.stopRequested = true
                break
              }
              continue
            }
            // file illeggibile o analisi fallita: niente Mix DJ per questo brano finché il file non cambia
            this.db.saveDj(t.id, null)
          }
          if (Date.now() - lastEmit > 1000) {
            lastEmit = Date.now()
            this.emit()
          }
        }
      }
    } finally {
      if (this.abort === abort) this.abort = null
      this.djRunning = false
      this.dj.close()
      this.emit()
    }
  }

  stop(): void {
    this.stopRequested = true
    this.abort?.abort()
  }
}
