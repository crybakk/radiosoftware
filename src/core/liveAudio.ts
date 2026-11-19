/**
 * Riconoscimento dei live dal suono: applausi e pubblico all'inizio o alla fine del brano.
 *
 * Gli applausi sono un rumore "piatto" (tutte le frequenze insieme, come un fruscio), la musica no: per ogni
 * mezzo secondo dei primi e degli ultimi secondi si misura la piattezza dello spettro (ffmpeg aspectralstats)
 * e il volume. Mezzi secondi piatti e non silenziosi = pubblico. È un indizio, non una certezza: il brano
 * finisce nella lista "Da controllare" e decidi tu (scelta di cristian del 20/11/2026).
 */
import { spawn } from 'node:child_process'

/** Secondi analizzati all'inizio e alla fine del brano. */
export const SECONDI_INIZIO = 10
export const SECONDI_FINE = 12
/** Piattezza oltre la quale mezzo secondo sembra rumore di pubblico (musica di solito sotto 0,2). */
export const PIATTEZZA_PUBBLICO = 0.3
/** Volume minimo (dBFS) perché conti: sotto è silenzio o coda di una dissolvenza. */
export const VOLUME_MINIMO = -50
/** Secondi di pubblico (inizio o fine) da cui il brano sembra live. */
export const SECONDI_LIVE = 3

export interface Frame {
  flatness: number
  rms: number
}

/** Righe stampate da ametadata: un valore di piattezza e uno di volume per ogni mezzo secondo. */
export function leggiFrame(out: string): Frame[] {
  const frames: Frame[] = []
  let flat: number | null = null
  for (const line of out.split(/\r?\n/)) {
    const f = line.match(/aspectralstats\.\d+\.flatness=(-?inf|nan|[-\d.e+]+)/i)
    if (f) {
      flat = Number(f[1])
      continue
    }
    const r = line.match(/astats\.Overall\.RMS_level=(-?inf|nan|[-\d.e+]+)/i)
    if (r && flat != null) {
      const rms = /inf|nan/i.test(r[1]) ? -Infinity : Number(r[1])
      frames.push({ flatness: Number.isFinite(flat) ? flat : 0, rms })
      flat = null
    }
  }
  return frames
}

/** Secondi di "pubblico" in una serie di mezzi secondi. */
export function secondiPubblico(frames: Frame[]): number {
  return frames.filter((f) => f.flatness >= PIATTEZZA_PUBBLICO && f.rms > VOLUME_MINIMO).length / 2
}

function misura(ffmpeg: string, path: string, dove: 'inizio' | 'fine', signal?: AbortSignal): Promise<Frame[]> {
  const pos = dove === 'inizio' ? ['-t', String(SECONDI_INIZIO)] : ['-sseof', `-${SECONDI_FINE}`]
  const args = [
    '-hide_banner',
    '-nostats',
    '-v',
    'error',
    ...(dove === 'fine' ? pos : []),
    '-i',
    path,
    ...(dove === 'inizio' ? pos : []),
    '-vn',
    '-af',
    'aformat=channel_layouts=mono,aresample=22050,asetnsamples=n=11025:p=0,aspectralstats=win_size=1024:measure=flatness,' +
      'astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=print:file=-',
    '-f',
    'null',
    '-'
  ]
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true, signal })
    let out = ''
    let err = ''
    p.stdout.on('data', (d: Buffer) => {
      if (out.length < 2_000_000) out += d.toString()
    })
    p.stderr.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString()
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(leggiFrame(out)) : reject(new Error(err.trim() || `ffmpeg è uscito con codice ${code}`))))
  })
}

/**
 * Secondi di pubblico (applausi, grida) all'inizio e alla fine del file: il più alto dei due.
 * Da SECONDI_LIVE in su il brano sembra un live.
 */
export async function secondiApplausi(ffmpeg: string, path: string, signal?: AbortSignal): Promise<number> {
  const inizio = secondiPubblico(await misura(ffmpeg, path, 'inizio', signal))
  const fine = secondiPubblico(await misura(ffmpeg, path, 'fine', signal))
  return Math.max(inizio, fine)
}
