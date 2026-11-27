import { spawn } from 'node:child_process'
import type { AnalysisResult } from './db'
import { BOUNDS_SAMPLE_RATE, findMusicBounds } from './musicBounds'

/** Soglia sotto la quale l'audio è considerato silenzio (LUFS momentanei). */
const SILENCE_LUFS = -45
/** Il punto di mix è dove il brano scende di questo valore sotto la sua loudness media. */
const MIX_DROP_LU = 12
/** Sovrapposizione massima tra due brani. */
const MAX_OVERLAP_SECONDS = 10
/** Finestra della misura "momentary" EBU R128. */
const MOMENTARY_WINDOW = 0.4

export interface LoudnessFrame {
  t: number
  m: number
}

/** Estrae dall'output di ffmpeg (filtro ebur128, log verbose) le misure momentanee e la loudness integrata. */
export function parseEbur128(stderr: string): { frames: LoudnessFrame[]; integrated: number | null } {
  const frames: LoudnessFrame[] = []
  const frameRe = /t:\s*([\d.]+)\s+TARGET:[^M]*M:\s*(-?[\d.]+|-?inf|nan)/
  for (const line of stderr.split(/\r?\n/)) {
    const m = frameRe.exec(line)
    if (m) {
      const value = Number(m[2])
      frames.push({ t: Number(m[1]), m: Number.isFinite(value) ? value : -200 })
    }
  }
  let integrated: number | null = null
  const summary = stderr.lastIndexOf('Summary:')
  if (summary >= 0) {
    const im = /I:\s*(-?[\d.]+)\s*LUFS/.exec(stderr.slice(summary))
    if (im) integrated = Number(im[1])
  }
  if (integrated != null && integrated <= -70) integrated = null
  return { frames, integrated }
}

/** Calcola inizio, fine e punto di mix a partire dalle misure di loudness. */
export function computeCuePoints(
  frames: LoudnessFrame[],
  integrated: number | null,
  duration: number,
  /** Dove comincia e finisce la musica (senza parlato, applausi, tracce fantasma): i punti restano dentro. */
  music?: { start: number; end: number }
): Omit<AnalysisResult, 'loudness' | 'duration'> {
  const end = duration > 0 ? duration : frames.length ? frames[frames.length - 1].t : 0
  const audible = frames.filter((f) => f.m > SILENCE_LUFS)
  if (!audible.length) return { cueIn: 0, cueOut: end, mixPoint: end }

  let cueIn = Math.max(0, audible[0].t - MOMENTARY_WINDOW)
  let cueOut = Math.min(end, audible[audible.length - 1].t)
  if (music && music.end - music.start > 0 && music.start < cueOut && music.end > cueIn) {
    cueIn = Math.max(cueIn, music.start)
    cueOut = Math.min(cueOut, music.end)
  }

  let mixPoint = cueOut
  if (integrated != null) {
    const threshold = integrated - MIX_DROP_LU
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].t <= cueOut && frames[i].m >= threshold) {
        mixPoint = Math.min(cueOut, frames[i].t)
        break
      }
    }
  }
  mixPoint = Math.max(mixPoint, cueOut - MAX_OVERLAP_SECONDS, cueIn)
  return { cueIn: round(cueIn), cueOut: round(cueOut), mixPoint: round(mixPoint) }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** Durata reale letta da ffmpeg ("time=" finale o "Duration:"). */
export function parseDuration(stderr: string): number {
  const times = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)]
  const last = times.at(-1)
  if (last) return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr)
  return d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
}

/** Tempo massimo predefinito per l'analisi di un file. */
export const ANALYSIS_TIMEOUT_MS = 60_000

/**
 * Analizza un file con ffmpeg: loudness EBU R128, inizio/fine dell'audio, punto di mix.
 * Per la musica (`music`) si legge anche l'audio, per togliere dall'inizio e dalla fine quello che non è musica
 * (parlato, applausi, rumore, tracce fantasma dopo un lungo silenzio): vedi musicBounds.ts. Il file non si tocca.
 * Una sola lettura del file. ffmpeg viene terminato se `signal` viene annullato o dopo `timeoutMs`
 * (per esempio un file su una cartella di rete che non risponde più).
 */
export function analyzeFile(
  ffmpegPath: string,
  file: string,
  signal?: AbortSignal,
  timeoutMs = ANALYSIS_TIMEOUT_MS,
  music = false
): Promise<AnalysisResult> {
  return new Promise((resolvePromise, reject) => {
    const input = ['-hide_banner', '-nostdin', '-loglevel', 'verbose', '-protocol_whitelist', 'file', '-i', file]
    const args = music
      ? [
          ...input,
          '-filter_complex',
          `[0:a:0]asplit=2[a][b];[a]ebur128[e];[b]aresample=${BOUNDS_SAMPLE_RATE},aformat=sample_fmts=flt:channel_layouts=mono[p]`,
          '-map',
          '[e]',
          '-f',
          'null',
          '-',
          '-map',
          '[p]',
          '-f',
          'f32le',
          'pipe:1'
        ]
      : [...input, '-vn', '-af', 'ebur128', '-f', 'null', '-']
    const proc = spawn(ffmpegPath, args, { windowsHide: true, signal, killSignal: 'SIGKILL' })
    let stderr = ''
    const chunks: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d: string) => (stderr += d))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`ffmpeg non ha finito l'analisi entro ${Math.round(timeoutMs / 1000)} secondi`))
        return
      }
      if (code !== 0) {
        reject(new Error(`ffmpeg ha restituito ${code}: ${stderr.slice(-300)}`))
        return
      }
      const { frames, integrated } = parseEbur128(stderr)
      const duration = parseDuration(stderr)
      let bounds: { start: number; end: number } | undefined
      if (music && chunks.length) {
        const all = Buffer.concat(chunks)
        const pcm = new Float32Array(Math.floor(all.length / 4))
        new Uint8Array(pcm.buffer).set(all.subarray(0, pcm.length * 4))
        chunks.length = 0
        const silence = computeCuePoints(frames, integrated, duration)
        try {
          bounds = findMusicBounds(pcm, BOUNDS_SAMPLE_RATE, silence.cueIn, silence.cueOut)
        } catch {
          // misura non riuscita: restano i punti del solo silenzio
        }
      }
      resolvePromise({ duration, loudness: integrated, ...computeCuePoints(frames, integrated, duration, bounds) })
    })
  })
}
