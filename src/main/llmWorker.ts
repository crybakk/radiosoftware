/**
 * Processo separato per l'AI locale (rotazioni e titoli). Il motore (llama.cpp) è codice nativo: se
 * finisce la memoria o va in errore grave chiude tutto il processo. Qui dentro si chiude solo questo
 * processo e la regia, che resta in onda, mostra un errore.
 * Parla con la regia a messaggi (vedi llmProcess.ts).
 */
import { llamaEngine } from './llm'
import type { WorkerReply, WorkerRequest } from './llmProcess'

interface ParentPort {
  on(ev: 'message', fn: (e: { data: WorkerRequest }) => void): void
  postMessage(m: WorkerReply): void
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort
const engine = llamaEngine()
let session: { ask(user: string): Promise<string>; close(): Promise<void> } | null = null

const reply = (m: WorkerReply): void => port?.postMessage(m)
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

port?.on('message', ({ data: r }) => {
  void (async () => {
    try {
      if (r.type === 'complete') {
        reply({ id: r.id, result: await engine.complete({ modelPath: r.modelPath, system: r.system, user: r.user, schema: r.schema }) })
      } else if (r.type === 'open') {
        session = await engine.open!({ modelPath: r.modelPath, system: r.system, schema: r.schema })
        reply({ id: r.id, result: '' })
      } else if (r.type === 'ask') {
        if (!session) throw new Error('modello non aperto')
        reply({ id: r.id, result: await session.ask(r.user) })
      } else if (r.type === 'close') {
        await session?.close()
        session = null
        reply({ id: r.id, result: '' })
      }
    } catch (e) {
      reply({ id: r.id, error: message(e) })
    }
  })()
})

reply({ id: 0, ready: true })
