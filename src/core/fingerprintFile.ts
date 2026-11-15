import { spawn } from 'node:child_process'
import { ffmpegDecodeArgs, fingerprint, fpToBytes, LIBRARY_HOP, s16ToFloat } from '../../ponte/controllo/src/impronta.ts'

/** Impronta audio di un file (stesso calcolo del ponte), in byte pronti da salvare. */
export function fingerprintFile(ffmpegPath: string, path: string, maxSeconds = 20 * 60): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ffmpegDecodeArgs(path, maxSeconds), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-500)))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg ha risposto ${code}`))
      resolve(fpToBytes(fingerprint(s16ToFloat(Buffer.concat(chunks)), LIBRARY_HOP)))
    })
  })
}
