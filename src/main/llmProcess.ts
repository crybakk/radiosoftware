/**
 * L'AI locale in un processo a parte (llmWorker.ts): se il motore nativo cade (memoria finita, errore
 * grave) si chiude solo quel processo e la regia mostra un errore invece di chiudersi.
 * Ogni generazione apre un processo nuovo e lo chiude alla fine: la memoria del modello torna tutta libera.
 */
import type { LlmEngine } from './ai'

export type WorkerRequest =
  | { id: number; type: 'complete'; modelPath: string; system: string; user: string; schema: object }
  | { id: number; type: 'open'; modelPath: string; system: string; schema: object }
  | { id: number; type: 'ask'; user: string }
  | { id: number; type: 'close' }

/** La richiesta senza il numero (lo mette Worker). */
type Request = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never

export type WorkerReply = { id: number; ready?: boolean; result?: string; error?: string }

/** Quel che serve di un processo figlio (utilityProcess di Electron, o uno finto nelle prove). */
export interface ChildLike {
  postMessage(m: WorkerRequest): void
  on(ev: 'message', fn: (m: WorkerReply) => void): unknown
  on(ev: 'exit', fn: (code: number) => void): unknown
  kill(): unknown
  /** Ultime righe scritte dal processo (per il registro quando cade). */
  lastOutput?(): string
}

/** Messaggio per chi è in regia quando il processo dell'AI cade. */
export function crashMessage(code: number): string {
  return (
    `il motore dell'AI si è chiuso all'improvviso (codice ${code}); la regia e la messa in onda non sono state toccate. ` +
    'Di solito succede quando il PC non ha abbastanza memoria libera: chiudi gli altri programmi e riprova, ' +
    'oppure dividi il palinsesto in due parti più corte'
  )
}

class Worker {
  private readonly waiting = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>()
  private nextId = 1
  private exited: number | null = null
  readonly ready: Promise<void>

  constructor(private readonly child: ChildLike, onLog: (s: string) => void) {
    let started = false
    this.ready = new Promise((resolve, reject) => {
      child.on('message', (m) => {
        if (m.ready) {
          started = true
          resolve()
          return
        }
        const w = this.waiting.get(m.id)
        if (!w) return
        this.waiting.delete(m.id)
        if (m.error != null) w.reject(new Error(m.error))
        else w.resolve(m.result ?? '')
      })
      child.on('exit', (code) => {
        this.exited = code
        if (!started) {
          reject(new Error(`processo dell'AI non partito (codice ${code})${child.lastOutput?.().trim() ? `: ${child.lastOutput().trim().slice(-500)}` : ''}`))
          return
        }
        if (this.waiting.size) {
          const out = child.lastOutput?.().trim()
          onLog(`processo dell'AI chiuso all'improvviso, codice ${code}${out ? `, ultimi messaggi:\n${out}` : ''}`)
        }
        for (const w of this.waiting.values()) w.reject(new Error(crashMessage(code)))
        this.waiting.clear()
      })
    })
  }

  request(r: Request, signal?: AbortSignal): Promise<string> {
    if (this.exited != null) return Promise.reject(new Error(crashMessage(this.exited)))
    if (signal?.aborted) return Promise.reject(new Error('interrotto'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      // interrompere = chiudere il processo: llama.cpp si ferma subito e libera la memoria
      const onAbort = (): void => {
        this.waiting.delete(id)
        reject(new Error('interrotto'))
        this.kill()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = <T>(fn: (v: T) => void) => (v: T): void => {
        signal?.removeEventListener('abort', onAbort)
        fn(v)
      }
      this.waiting.set(id, { resolve: done(resolve), reject: done(reject) })
      this.child.postMessage({ ...r, id } as WorkerRequest)
    })
  }

  kill(): void {
    if (this.exited == null) this.child.kill()
  }
}

/**
 * Motore che usa un processo separato. `fallback` (il motore nello stesso processo) si usa solo se il
 * processo separato non riesce proprio a partire, così l'AI funziona comunque.
 */
export function processEngine(o: { spawn: () => ChildLike; fallback?: LlmEngine; log?: (s: string) => void }): LlmEngine {
  const log = o.log ?? (() => {})
  const start = async (): Promise<Worker | null> => {
    try {
      const w = new Worker(o.spawn(), log)
      await w.ready
      return w
    } catch (e) {
      if (!o.fallback) throw e
      log(`AI nello stesso processo della regia: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }
  return {
    async complete(a) {
      const w = await start()
      if (!w) return o.fallback!.complete(a)
      try {
        return await w.request({ type: 'complete', modelPath: a.modelPath, system: a.system, user: a.user, schema: a.schema }, a.signal)
      } finally {
        w.kill()
      }
    },
    async open(a) {
      const w = await start()
      if (!w) {
        const f = o.fallback!
        if (f.open) return f.open(a)
        return { ask: (user, signal) => f.complete({ ...a, user, signal }), close: async () => {} }
      }
      try {
        await w.request({ type: 'open', modelPath: a.modelPath, system: a.system, schema: a.schema })
      } catch (e) {
        w.kill()
        throw e
      }
      return {
        ask: (user, signal) => w.request({ type: 'ask', user }, signal),
        async close() {
          await w.request({ type: 'close' }).catch(() => {})
          w.kill()
        }
      }
    }
  }
}
