/**
 * AI locale della regia per le rotazioni: scaricamento del modello (una volta sola, riprende se si
 * interrompe) e generazione del piano dal palinsesto scritto a parole.
 * Il motore vero (node-llama-cpp) è in llm.ts; qui si può sostituire con uno finto nelle prove.
 */
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  buildPrompt,
  cleanPlan,
  matchCount,
  planSchema,
  promptGenres,
  summarize,
  type AiPlan,
  type LibrarySummary
} from '../core/aiRotation'
import type { Track } from '../core/types'

export const AI_MODEL = {
  name: 'Qwen3 4B Instruct',
  license: 'Apache 2.0',
  file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
  sizeMb: 2500
}

export interface AiStatus {
  modelName: string
  sizeMb: number
  installed: boolean
  downloading: boolean
  /** 0..1 durante lo scaricamento (anche la parte già scaricata le volte prima). */
  progress: number
  /** MB già scaricati (parte interrotta compresa). */
  downloadedMb: number
  /** Sta generando un piano. */
  busy: boolean
  error: string | null
}

export interface AiResult {
  plan: AiPlan
  warnings: string[]
  /** Brani di musica che rispettano ogni fascia (stesso ordine delle fasce). */
  counts: number[]
  music: number
  seconds: number
}

export interface LlmEngine {
  /** Risposta del modello vincolata allo schema JSON. */
  complete(o: { modelPath: string; system: string; user: string; schema: object; signal?: AbortSignal }): Promise<string>
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Scarica un file grande riprendendo da dove si era fermato (file ".part" e richiesta Range).
 * Alla fine rinomina il file: un file completo c'è solo se lo scaricamento è finito.
 */
export async function downloadResumable(o: {
  url: string
  dest: string
  fetch?: Fetch
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<void> {
  const part = `${o.dest}.part`
  const have = existsSync(part) ? statSync(part).size : 0
  const r = await (o.fetch ?? ((u, i) => fetch(u, i)))(o.url, {
    redirect: 'follow',
    headers: have ? { Range: `bytes=${have}-` } : {},
    signal: o.signal
  })
  if (r.status === 416) {
    // la parte scaricata è già tutto il file
    await rename(part, o.dest)
    return
  }
  if (!r.ok || !r.body) throw new Error(`scaricamento non riuscito (errore ${r.status})`)
  const resumed = r.status === 206
  const start = resumed ? have : 0
  const total = start + Number(r.headers.get('content-length') ?? 0)
  let done = start
  let last = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length
      if (o.onProgress && Date.now() - last > 500) {
        last = Date.now()
        o.onProgress(done, total)
      }
      cb(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(r.body as never), count, createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal: o.signal })
  if (total > start && done !== total) throw new Error('scaricamento interrotto')
  o.onProgress?.(done, total)
  await rename(part, o.dest)
}

export class AiService {
  private readonly dir: string
  private readonly engine: LlmEngine
  private readonly fetchFn?: Fetch
  private readonly onStatus: (s: AiStatus) => void
  private downloading: AbortController | null = null
  private generating: AbortController | null = null
  private progress = 0
  private downloadedMb = 0
  private error: string | null = null

  constructor(o: { dir: string; engine: LlmEngine; onStatus?: (s: AiStatus) => void; fetch?: Fetch }) {
    this.dir = o.dir
    this.engine = o.engine
    this.fetchFn = o.fetch
    this.onStatus = o.onStatus ?? (() => {})
  }

  get modelPath(): string {
    return join(this.dir, AI_MODEL.file)
  }

  status(): AiStatus {
    const part = `${this.modelPath}.part`
    const installed = existsSync(this.modelPath)
    const partMb = !this.downloading && existsSync(part) ? Math.round(statSync(part).size / 1e6) : installed ? 0 : this.downloadedMb
    return {
      modelName: AI_MODEL.name,
      sizeMb: AI_MODEL.sizeMb,
      installed,
      downloading: !!this.downloading,
      progress: installed ? 1 : this.downloading ? this.progress : Math.min(1, partMb / AI_MODEL.sizeMb),
      downloadedMb: partMb,
      busy: !!this.generating,
      error: this.error
    }
  }

  private emit(): void {
    this.onStatus(this.status())
  }

  /** Scarica il modello (in background: lo stato arriva con onStatus). */
  async download(): Promise<void> {
    if (this.downloading || existsSync(this.modelPath)) return
    const ac = new AbortController()
    this.downloading = ac
    this.error = null
    this.emit()
    try {
      await mkdir(this.dir, { recursive: true })
      await downloadResumable({
        url: AI_MODEL.url,
        dest: this.modelPath,
        fetch: this.fetchFn,
        signal: ac.signal,
        onProgress: (done, total) => {
          this.progress = total ? done / total : 0
          this.downloadedMb = Math.round(done / 1e6)
          this.emit()
        }
      })
    } catch (e) {
      if (!ac.signal.aborted) this.error = `modello non scaricato: ${e instanceof Error ? e.message : String(e)} (riprova: riparte da dove si è fermato)`
    } finally {
      this.downloading = null
      this.emit()
    }
  }

  /** Ferma lo scaricamento: la parte scaricata resta e si riprende dopo. */
  cancelDownload(): void {
    this.downloading?.abort()
  }

  async removeModel(): Promise<void> {
    this.cancelDownload()
    await rm(this.modelPath, { force: true })
    await rm(`${this.modelPath}.part`, { force: true })
    this.emit()
  }

  stop(): void {
    this.cancelDownload()
    this.generating?.abort()
  }

  /** Dal palinsesto a parole al piano di fasce, già ricontrollato, con i brani di ogni fascia. */
  async generate(description: string, music: Track[]): Promise<AiResult> {
    if (!description.trim()) throw new Error('scrivi prima il palinsesto')
    if (description.length > 4000) throw new Error('palinsesto troppo lungo (massimo 4000 caratteri)')
    if (!existsSync(this.modelPath)) throw new Error('scarica prima il modello')
    if (this.generating) throw new Error('sto già generando un piano')
    const ac = new AbortController()
    this.generating = ac
    this.error = null
    this.emit()
    const t0 = Date.now()
    try {
      const summary: LibrarySummary = summarize(music)
      const { system, user } = buildPrompt(description, summary)
      const raw = await this.engine.complete({ modelPath: this.modelPath, system, user, schema: planSchema(promptGenres(summary)), signal: ac.signal })
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('l\'AI ha risposto in un formato non valido: riprova o scrivi il palinsesto in modo più semplice')
      }
      const { plan, warnings } = cleanPlan(parsed, summary)
      return { plan, warnings, ...previewCounts(plan, music), seconds: Math.round((Date.now() - t0) / 1000) }
    } finally {
      this.generating = null
      this.emit()
    }
  }
}

/** Brani di ogni fascia (per l'anteprima, anche dopo una modifica a mano). */
export function previewCounts(plan: AiPlan, music: Track[]): { counts: number[]; music: number } {
  return { counts: plan.slots.map((s) => matchCount(s, music)), music: music.length }
}
