import { spawn } from 'node:child_process'
import { ffmpegDecodeArgs, fingerprint, fpToBytes, LIBRARY_HOP, s16ToFloat } from '../../ponte/controllo/src/impronta.ts'

/** Oltre questo tempo ffmpeg è bloccato (file su un disco di rete sparito, file strano): si ferma. */
const TIMEOUT_MS = 5 * 60_000

/** Impronta audio di un file (stesso calcolo del ponte), in byte pronti da salvare. */
export function fingerprintFile(ffmpegPath: string, path: string, maxSeconds = 20 * 60, timeoutMs = TIMEOUT_MS): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ffmpegDecodeArgs(path, maxSeconds), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks: Buffer[] = []
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      p.kill('SIGKILL')
    }, timeoutMs)
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-500)))
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error('ffmpeg non ha finito in tempo'))
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg ha risposto ${code}`))
      resolve(fpToBytes(fingerprint(s16ToFloat(Buffer.concat(chunks)), LIBRARY_HOP)))
    })
  })
}
