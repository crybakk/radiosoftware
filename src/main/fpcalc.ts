/**
 * fpcalc (Chromaprint, il programma ufficiale di AcoustID): impronta dei primi 120 secondi del brano.
 * Nell'installatore è in resources/fpcalc; in sviluppo si può indicare con RADIO_FPCALC.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function fpcalcPath(): string | null {
  const env = process.env.RADIO_FPCALC
  if (env) return existsSync(env) ? env : null
  const res = (process as { resourcesPath?: string }).resourcesPath
  const exe = process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc'
  const p = res ? join(res, 'fpcalc', exe) : ''
  return p && existsSync(p) ? p : null
}

/** fpcalc non si può avviare: va sistemato il programma, i brani non c'entrano. */
export class FpcalcMissing extends Error {}

export function fingerprint(bin: string, file: string, signal?: AbortSignal): Promise<{ fingerprint: string; duration: number }> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-json', '-length', '120', file], { timeout: 60_000, signal, windowsHide: true }, (err, stdout) => {
      if (err) {
        // fpcalc non parte (mancante, bloccato dall'antivirus, senza permessi): non è colpa del brano
        const code = (err as { code?: unknown }).code
        if (typeof code === 'string' && code !== 'ABORT_ERR' && !code.startsWith('ERR_')) return reject(new FpcalcMissing(`fpcalc non si avvia (${code})`))
        return reject(new Error(`impronta non calcolata: ${err.message}`))
      }
      try {
        const j = JSON.parse(stdout) as { fingerprint?: string; duration?: number }
        if (!j.fingerprint) throw new Error('vuota')
        resolve({ fingerprint: j.fingerprint, duration: Number(j.duration ?? 0) })
      } catch {
        reject(new Error('impronta non valida'))
      }
    })
  })
}
