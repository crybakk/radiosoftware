/**
 * Motore AI locale: node-llama-cpp con il modello GGUF scaricato, solo processore (niente scheda video),
 * caricato solo quando serve e chiuso subito dopo, per lasciare memoria e processore alla messa in onda.
 * La risposta è vincolata da una grammatica costruita dallo schema JSON: il modello non può scrivere altro.
 */
import { statSync } from 'node:fs'
import { cpus, freemem } from 'node:os'
import type { Llama, LlamaGrammar } from 'node-llama-cpp'
import type { LlmEngine } from './ai'

/**
 * La grammatica JSON di node-llama-cpp lascia al modello andare a capo e rientrare ogni campo: più di metà
 * dei pezzi generati erano spazi (un piano di 11 fasce: ~2100 pezzi, 7 minuti su un i7). Qui le regole degli
 * spazi diventano "al massimo uno spazio": JSON su una riga, risposta molto più corta e veloce.
 * Se la forma della grammatica cambiasse (altra versione del pacchetto) resta quella originale.
 */
export function compactJsonGrammar(gbnf: string): string {
  return gbnf
    .split('\n')
    .map((line) => {
      const m = /^((comma-)?whitespace-[\w-]+) ::= (.*)$/.exec(line)
      if (!m || !m[3].includes('[\\n]')) return line
      return m[2] ? `${m[1]} ::= "," [ ]?` : `${m[1]} ::= [ ]?`
    })
    .join('\n')
}

/** Grammatica dallo schema JSON, in versione compatta. */
async function jsonGrammar(llama: Llama, schema: object): Promise<LlamaGrammar> {
  const { LlamaText } = await import('node-llama-cpp')
  const base = await llama.createGrammarForJsonSchema(schema as never)
  const compact = compactJsonGrammar(base.grammar)
  if (compact === base.grammar) return base
  return llama.createGrammar({ grammar: compact, stopGenerationTriggers: [LlamaText(['\n\n\n\n'])], trimWhitespaceSuffix: true })
}

/** Pezzi massimi della risposta di un piano: 30 fasce in JSON compatto stanno sotto i 3000. */
const PLAN_MAX_TOKENS = 3000
/** Memoria del contesto per ogni posizione (Qwen3 4B: 36 strati × 8 teste × 128 × 2 × 2 byte ≈ 150 kB). */
const KV_BYTES_PER_TOKEN = 150_000

/**
 * Contesto grande quanto serve (istruzioni + domanda + risposta), non 8192 fissi: su un PC con 8 GB
 * ogni mezzo giga conta.
 */
export function planContextSize(promptTokens: number, maxTokens = PLAN_MAX_TOKENS): number {
  return Math.min(8192, Math.max(2048, Math.ceil((promptTokens + maxTokens + 200) / 256) * 256))
}

/** Memoria che serve, in byte: modello + contesto + margine per i calcoli. */
export function memoryNeeded(modelBytes: number, contextSize: number): number {
  return modelBytes + contextSize * KV_BYTES_PER_TOKEN + 400e6
}

/**
 * Meglio dirlo prima che cadere a metà: se il PC non ha abbastanza memoria libera, un messaggio chiaro.
 * (Windows conta come libera anche la memoria che tiene da parte per i file, che si libera da sola.)
 */
export function checkMemory(need: number, free: number): void {
  if (free >= need) return
  const gb = (b: number): string => (b / 1e9).toFixed(1).replace('.', ',')
  throw new Error(
    `memoria insufficiente: l'AI ha bisogno di circa ${gb(need)} GB liberi e adesso ce ne sono ${gb(free)}. ` +
      'Chiudi gli altri programmi aperti sul PC (browser, editor audio…) e riprova'
  )
}

/**
 * Passi del motore scritti sull'uscita del processo: se il processo dell'AI cade, la regia mette le
 * ultime righe nel registro (logs\\regia.log) e si vede dove si è fermato e con quanta memoria.
 */
function step(msg: string): void {
  const mb = (b: number): string => `${Math.round(b / 1e6)} MB`
  console.log(`[AI] ${msg} · memoria usata ${mb(process.memoryUsage().rss)}, libera ${mb(freemem())}`)
}

export function llamaEngine(): LlmEngine {
  return {
    async open({ modelPath, system, schema }) {
      // come complete(), ma il modello resta aperto per tante domande di fila (analisi dei titoli)
      const { getLlama, LlamaChatSession } = await import('node-llama-cpp')
      const llama = await getLlama({ gpu: false, build: 'never' })
      checkMemory(memoryNeeded(statSync(modelPath).size, 4096), freemem())
      const model = await llama.loadModel({ modelPath }).catch((e: unknown) => {
        throw new Error(`il modello non si apre (${e instanceof Error ? e.message : String(e)}): eliminalo e scaricalo di nuovo`)
      })
      const threads = Math.max(1, Math.min(8, cpus().length - 2))
      const context = await model.createContext({ contextSize: 4096, threads }).catch(async (e: unknown) => {
        await model.dispose()
        throw e
      })
      const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: system })
      const grammar = await jsonGrammar(llama, schema)
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
      step('avvio')
      const llama = await getLlama({ gpu: false, build: 'never' })
      step(`motore pronto (${llama.systemInfo})`)
      // controllo prima di caricare (pezzi stimati: circa 3 caratteri l'uno)
      checkMemory(memoryNeeded(statSync(modelPath).size, planContextSize(Math.ceil((system.length + user.length) / 3))), freemem())
      const model = await llama.loadModel({ modelPath }).catch((e: unknown) => {
        throw new Error(`il modello non si apre (${e instanceof Error ? e.message : String(e)}): eliminalo e scaricalo di nuovo`)
      })
      try {
        // lascia almeno due core liberi per l'audio
        const threads = Math.max(1, Math.min(8, cpus().length - 2))
        const contextSize = planContextSize(model.tokenize(system).length + model.tokenize(user).length + 100)
        step(`modello caricato, creo il contesto da ${contextSize} con ${threads} thread`)
        const context = await model.createContext({ contextSize, threads })
        try {
          step('contesto pronto')
          const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: system })
          const grammar = await jsonGrammar(llama, schema)
          step('grammatica pronta, comincio a scrivere')
          let n = 0
          const answer = await session.prompt(user, {
            grammar,
            temperature: 0.2,
            maxTokens: PLAN_MAX_TOKENS,
            signal,
            onTextChunk: () => {
              if (++n % 200 === 0) step(`${n} pezzi scritti`)
            }
          })
          step(`finito: ${n} pezzi`)
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
