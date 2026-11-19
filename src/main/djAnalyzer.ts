import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import type { DjAnalysis } from '../core/djAnalysis'
import type { DjJob } from './djWorker'

/** Frequenza di campionamento usata da Essentia per ritmo e tonalità. */
export const DJ_SAMPLE_RATE = 44100
/** Il thread di analisi si riavvia ogni tanti brani: libera la memoria di WebAssembly. */
const RESTART_EVERY = 100

/** Decodifica un file in mono float a 44,1 kHz con ffmpeg. */
export function decodeMono(ffmpegPath: string, file: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', file, '-vn', '-ac', '1', '-ar', String(DJ_SAMPLE_RATE), '-f', 'f32le', '-'],
      { windowsHide: true, signal, killSignal: 'SIGKILL' }
    )
    const chunks: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d: string) => (err = (err + d).slice(-500)))
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`ffmpeg ha restituito ${code}: ${err}`))
      const all = Buffer.concat(chunks)
      const out = new Float32Array(Math.floor(all.length / 4))
      new Uint8Array(out.buffer).set(all.subarray(0, out.length * 4))
      resolve(out)
    })
  })
}

/** Un thread di Essentia che analizza un brano alla volta. */
export class DjAnalyzer {
  private worker: Worker | null = null
  private jobs = 0
  private nextId = 1

  constructor(private workerUrl: URL) {}

  async analyze(signal: Float32Array, cueIn: number, cueOut: number, timeoutMs = 120_000): Promise<DjAnalysis> {
    if (!this.worker || this.jobs >= RESTART_EVERY) this.restart()
    this.jobs++
    const worker = this.worker!
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        this.close()
        reject(new Error('analisi troppo lunga'))
      }, timeoutMs)
      const onMessage = (m: { id: number; result?: DjAnalysis; error?: string }): void => {
        if (m.id !== id) return
        cleanup()
        if (m.result) resolve(m.result)
        else reject(new Error(m.error ?? 'analisi non riuscita'))
      }
      const onError = (e: Error): void => {
        cleanup()
        this.worker = null
        reject(e)
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        worker.off('message', onMessage)
        worker.off('error', onError)
      }
      worker.on('message', onMessage)
      worker.on('error', onError)
      const job: DjJob = { id, pcm: signal.buffer as ArrayBuffer, sampleRate: DJ_SAMPLE_RATE, cueIn, cueOut }
      worker.postMessage(job, [job.pcm])
    })
  }

  close(): void {
    void this.worker?.terminate()
    this.worker = null
  }

  private restart(): void {
    this.close()
    this.jobs = 0
    this.worker = new Worker(this.workerUrl)
  }
}
