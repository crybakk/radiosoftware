/**
 * Thread separato per l'analisi "da DJ": Essentia lavora qualche secondo per brano e
 * non deve bloccare il processo principale della regia.
 */
import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { analyzeDjSignal, type EssentiaLike } from '../core/djAnalysis'

const require = createRequire(import.meta.url)
const { Essentia, EssentiaWASM } = require('essentia.js') as {
  Essentia: new (wasm: unknown) => EssentiaLike
  EssentiaWASM: unknown
}
const essentia = new Essentia(EssentiaWASM)

export interface DjJob {
  id: number
  pcm: ArrayBuffer
  sampleRate: number
  cueIn: number
  cueOut: number
}

parentPort?.on('message', (job: DjJob) => {
  try {
    const signal = new Float32Array(job.pcm)
    const result = analyzeDjSignal(essentia, signal, job.sampleRate, job.cueIn, job.cueOut)
    parentPort?.postMessage({ id: job.id, result })
  } catch (err) {
    parentPort?.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) })
  }
})
