/**
 * Motore AI locale: node-llama-cpp con il modello GGUF scaricato, solo processore (niente scheda video),
 * caricato solo quando serve e chiuso subito dopo, per lasciare memoria e processore alla messa in onda.
 * La risposta è vincolata da una grammatica costruita dallo schema JSON: il modello non può scrivere altro.
 */
import { cpus } from 'node:os'
import type { LlmEngine } from './ai'

export function llamaEngine(): LlmEngine {
  return {
    async open({ modelPath, system, schema }) {
      // come complete(), ma il modello resta aperto per tante domande di fila (analisi dei titoli)
      const { getLlama, LlamaChatSession } = await import('node-llama-cpp')
      const llama = await getLlama({ gpu: false, build: 'never' })
      const model = await llama.loadModel({ modelPath }).catch((e: unknown) => {
        throw new Error(`il modello non si apre (${e instanceof Error ? e.message : String(e)}): eliminalo e scaricalo di nuovo`)
      })
      const threads = Math.max(1, Math.min(8, cpus().length - 2))
      const context = await model.createContext({ contextSize: 4096, threads }).catch(async (e: unknown) => {
        await model.dispose()
        throw e
      })
      const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: system })
      const grammar = await llama.createGrammarForJsonSchema(schema as never)
      return {
        async ask(user, signal) {
          // ogni domanda da capo: le risposte di prima non devono influenzare le altre
          session.resetChatHistory()
          return session.prompt(user, { grammar, temperature: 0.1, maxTokens: 1500, signal })
        },
        async close() {
          await context.dispose()
          await model.dispose()
        }
      }
    },
    async complete({ modelPath, system, user, schema, signal }) {
      // il modulo (nativo, grande) si carica solo alla prima generazione
      const { getLlama, LlamaChatSession } = await import('node-llama-cpp')
      // niente compilazione sul PC di regia: solo i binari già pronti del pacchetto
      const llama = await getLlama({ gpu: false, build: 'never' })
      const model = await llama.loadModel({ modelPath }).catch((e: unknown) => {
        throw new Error(`il modello non si apre (${e instanceof Error ? e.message : String(e)}): eliminalo e scaricalo di nuovo`)
      })
      try {
        // lascia almeno due core liberi per l'audio
        const threads = Math.max(1, Math.min(8, cpus().length - 2))
        const context = await model.createContext({ contextSize: 8192, threads })
        try {
          const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: system })
          const grammar = await llama.createGrammarForJsonSchema(schema as never)
          const answer = await session.prompt(user, { grammar, temperature: 0.2, maxTokens: 4000, signal })
          return answer
        } finally {
          await context.dispose()
        }
      } finally {
        await model.dispose()
      }
    }
  }
}
