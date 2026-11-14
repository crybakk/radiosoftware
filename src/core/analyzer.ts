import { spawn } from 'node:child_process'
import type { AnalysisResult } from './db'

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
  duration: number
): Omit<AnalysisResult, 'loudness' | 'duration'> {
  const end = duration > 0 ? duration : frames.length ? frames[frames.length - 1].t : 0
  const audible = frames.filter((f) => f.m > SILENCE_LUFS)
  if (!audible.length) return { cueIn: 0, cueOut: end, mixPoint: end }

  const cueIn = Math.max(0, audible[0].t - MOMENTARY_WINDOW)
  const cueOut = Math.min(end, audible[audible.length - 1].t)

  let mixPoint = cueOut
  if (integrated != null) {
    const threshold = integrated - MIX_DROP_LU
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].m >= threshold) {
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

/**
 * Analizza un file con ffmpeg: loudness EBU R128, inizio/fine dell'audio, punto di mix.
 * Una sola lettura del file.
 */
export function analyzeFile(ffmpegPath: string, file: string, signal?: AbortSignal): Promise<AnalysisResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-nostdin', '-loglevel', 'verbose', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'],
      { windowsHide: true, signal }
    )
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d: string) => (stderr += d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg ha restituito ${code}: ${stderr.slice(-300)}`))
        return
      }
      const { frames, integrated } = parseEbur128(stderr)
      const duration = parseDuration(stderr)
      resolvePromise({ duration, loudness: integrated, ...computeCuePoints(frames, integrated, duration) })
    })
  })
}
