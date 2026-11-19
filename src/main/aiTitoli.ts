/**
 * Analisi dei titoli della libreria con l'AI locale, in background, a gruppi di brani.
 * Il modello resta aperto per tutta l'analisi e si chiude alla fine; si ferma e si riprende quando vuoi
 * (i brani già giudicati non si rifanno).
 */
import { existsSync } from 'node:fs'
import { BATCH_TITOLI, leggiTitoli, promptTitoli, schemaTitoli, SYSTEM_TITOLI } from '../core/aiTitoli'
import type { RadioDb } from '../core/db'
import type { LlmEngine } from './ai'

export interface AiTitoliStatus {
  running: boolean
  done: number
  total: number
  /** Brani segnalati dall'AI in questa analisi. */
  flagged: number
  error: string | null
}

export class AiTitoliService {
  private ac: AbortController | null = null
  private flagged = 0
  private error: string | null = null

  constructor(
    private readonly o: {
      db: RadioDb
      engine: LlmEngine
      modelPath: () => string
      /** L'AI sta già lavorando (piano delle rotazioni): non si parte insieme. */
      busy: () => boolean
      onStatus?: (s: AiTitoliStatus) => void
    }
  ) {}

  status(): AiTitoliStatus {
    const s = this.o.db.aiTitoliStats()
    return { running: !!this.ac, done: s.done, total: s.total, flagged: this.flagged, error: this.error }
  }

  private emit(): void {
    this.o.onStatus?.(this.status())
  }

  stop(): void {
    this.ac?.abort()
  }

  /** Parte (in background); errore subito se il modello non c'è o l'AI è occupata. */
  start(): void {
    if (this.ac) return
    if (!existsSync(this.o.modelPath())) throw new Error("scarica prima il modello dell'AI (Eventi → Rotazioni con l'AI)")
    if (this.o.busy()) throw new Error("l'AI sta già preparando un piano delle rotazioni: riprova quando ha finito")
    const ac = (this.ac = new AbortController())
    this.flagged = 0
    this.error = null
    this.emit()
    void this.run(ac).finally(() => {
      this.ac = null
      this.emit()
    })
  }

  private async run(ac: AbortController): Promise<void> {
    const { db, engine } = this.o
    const modelPath = this.o.modelPath()
    const schema = schemaTitoli()
    let session: Awaited<ReturnType<NonNullable<LlmEngine['open']>>> | null = null
    try {
      session = engine.open
        ? await engine.open({ modelPath, system: SYSTEM_TITOLI, schema })
        : { ask: (user, signal) => engine.complete({ modelPath, system: SYSTEM_TITOLI, user, schema, signal }), close: async () => {} }
      let errori = 0
      for (;;) {
        if (ac.signal.aborted) break
        const batch = db.pendingAiTitoli(BATCH_TITOLI)
        if (!batch.length) break
        let results: { id: number; motivo: string }[]
        try {
          results = leggiTitoli(await session.ask(promptTitoli(batch), ac.signal), batch)
          errori = 0
        } catch (e) {
          if (ac.signal.aborted) break
          // una risposta rovinata ogni tanto capita: dopo tre di fila ci si ferma
          if (++errori >= 3) throw e
          continue
        }
        db.saveAiTitoli(results)
        this.flagged += results.filter((r) => r.motivo).length
        this.emit()
      }
    } catch (e) {
      this.error = `analisi dei titoli fermata: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      await session?.close().catch(() => {})
    }
  }
}
