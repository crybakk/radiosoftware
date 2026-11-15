import { ANALYSIS_TIMEOUT_MS, analyzeFile } from '../core/analyzer'
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
  private stopRequested = false
  private abort: AbortController | null = null
  private listeners = new Set<(s: LibraryStatus) => void>()

  constructor(
    private db: RadioDb,
    private ffmpegPath: string | null
  ) {}

  onStatus(cb: (s: LibraryStatus) => void): void {
    this.listeners.add(cb)
  }

  status(): LibraryStatus {
    return { ...this.db.libraryStats(), scanning: this.scanning, analyzing: this.analyzing }
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
  }

  stop(): void {
    this.stopRequested = true
    this.abort?.abort()
  }
}
