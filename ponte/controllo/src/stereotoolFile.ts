/**
 * Stereo Tool sui file (puntate registrate in regia): ultimo passaggio prima della pubblicazione.
 *
 * L'elaborazione gira in un processo a parte (stereotoolElabora.ts) con la priorità più bassa del
 * sistema (nice 19) e una alla volta: usa un solo core e cede sempre il processore alla diretta.
 * La libreria, il preset e la chiave sono gli stessi della diretta (cartella ./stereotool del server).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIBRERIA, PRESET } from './stereotool.ts'

export interface ElaboraOpzioni {
  /** Cartella con libStereoTool.so e preset.sts. */
  dir: string
  key: string
  bitrate: string
  ffmpeg?: string
  /** "nice" per la priorità bassa; vuoto nei test o dove non c'è. */
  nice?: string
  /** Tempo massimo (ms): oltre si ferma tutto. */
  timeoutMs?: number
}

/** Perché Stereo Tool non si può usare (null se si può). */
export function stereoToolMancante(dir: string): string | null {
  if (!existsSync(join(dir, LIBRERIA))) return 'manca la libreria di Stereo Tool sul server'
  if (!existsSync(join(dir, PRESET))) return 'manca il preset di Stereo Tool: caricalo dal pannello'
  return null
}

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'stereotoolElabora.ts')

/** Una elaborazione alla volta: la seconda aspetta che finisca la prima. */
let coda: Promise<unknown> = Promise.resolve()

/** Taglia `input` tra from e to (secondi), lo passa in Stereo Tool e lo scrive in `output` (MP3). */
export function elaboraConStereoTool(input: string, output: string, from: number, to: number, o: ElaboraOpzioni): Promise<void> {
  const job = coda.then(() => esegui(input, output, from, to, o))
  coda = job.catch(() => {})
  return job
}

function esegui(input: string, output: string, from: number, to: number, o: ElaboraOpzioni): Promise<void> {
  const why = stereoToolMancante(o.dir)
  if (why) return Promise.reject(new Error(why))
  const args = [SCRIPT, join(o.dir, LIBRERIA), join(o.dir, PRESET), input, output, String(from), String(to), o.bitrate]
  const nice = o.nice ?? 'nice'
  const [cmd, cmdArgs] = nice ? [nice, ['-n', '19', process.execPath, ...args]] : [process.execPath, args]
  return new Promise((ok, fail) => {
    const c = spawn(cmd, cmdArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, STEREOTOOL_CHIAVE: o.key, FFMPEG: o.ffmpeg ?? 'ffmpeg' }
    })
    let err = ''
    c.stderr.on('data', (d: Buffer) => (err = (err + String(d)).slice(-1000)))
    const timer = setTimeout(() => c.kill('SIGKILL'), o.timeoutMs ?? 6 * 3600_000)
    c.on('error', (e) => {
      clearTimeout(timer)
      fail(new Error(`Stereo Tool non parte: ${e.message}`))
    })
    c.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) ok()
      else fail(new Error(`Stereo Tool: ${err.trim().split('\n').pop() || `uscito con codice ${code}`}`))
    })
  })
}
