import { analyzeFile } from '../core/analyzer'
import { fingerprintFile } from '../core/fingerprintFile'
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
  private stopRequested = false
  private listeners = new Set<(s: LibraryStatus) => void>()

  constructor(
    private db: RadioDb,
    private ffmpegPath: string | null
  ) {}

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
      fingerprinting: this.fingerprinting
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
    this.emit()
    let lastEmit = 0
    try {
      for (;;) {
        const batch = this.db.pendingAnalysis(20)
        if (!batch.length || this.stopRequested) break
        for (const t of batch) {
          if (this.stopRequested) break
          try {
            const r = await analyzeFile(this.ffmpegPath, t.path)
            this.db.saveAnalysis(t.id, r)
          } catch {
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
  }

  stop(): void {
    this.stopRequested = true
  }
}
