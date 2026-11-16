/**
 * Motore AI locale: node-llama-cpp con il modello GGUF scaricato, solo processore (niente scheda video),
 * caricato solo quando serve e chiuso subito dopo, per lasciare memoria e processore alla messa in onda.
 * La risposta è vincolata da una grammatica costruita dallo schema JSON: il modello non può scrivere altro.
 */
import { cpus } from 'node:os'
import type { LlmEngine } from './ai'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function llamaEngine(): LlmEngine {
  return {
    async complete({ modelPath, system, user, schema, signal }) {
      // import con il nome in una variabile: il modulo (nativo, grande) si carica solo alla prima generazione
      const name = 'node-llama-cpp'
      const { getLlama, LlamaChatSession } = (await import(name)) as any
      // niente compilazione sul PC di regia: solo i binari già pronti del pacchetto
      const llama = await getLlama({ gpu: false, build: 'never' })
      const model = await llama.loadModel({ modelPath })
      try {
        // lascia almeno due core liberi per l'audio
        const threads = Math.max(1, Math.min(8, cpus().length - 2))
        const context = await model.createContext({ contextSize: 8192, threads })
        try {
          const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: system })
          const grammar = await llama.createGrammarForJsonSchema(schema)
          const answer: string = await session.prompt(user, { grammar, temperature: 0.2, maxTokens: 4000, signal })
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
