// Impostazioni del mixer: valori di partenza e pulizia (file rovinati, versioni vecchie).
import type { Canale, ImpostazioniMixer } from './api'

export const MAX_CANALI = 4
export const DB_MIN = -60
export const DB_MAX = 12

export function nuovoCanale(n: number): Canale {
  return { id: `c${Date.now().toString(36)}${n}`, nome: `Microfono ${n}`, deviceId: '', parte: 'stereo', volumeDb: 0, muto: false }
}

export function mixerPredefinito(): ImpostazioniMixer {
  return {
    canali: [nuovoCanale(1)],
    pc: { attivo: false, volumeDb: -6, muto: false, inCuffia: false },
    cuffiaId: '',
    cuffiaVolume: 0.8,
    ritorno: true,
    ritornoVolume: 0.7,
    kbps: 160
  }
}

const num = (v: unknown, min: number, max: number, d: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

export function pulisciMixer(m: unknown): ImpostazioniMixer {
  const d = mixerPredefinito()
  if (!m || typeof m !== 'object') return d
  const x = m as Partial<ImpostazioniMixer>
  const canali = (Array.isArray(x.canali) ? x.canali : [])
    .slice(0, MAX_CANALI)
    .filter((c): c is Canale => !!c && typeof c === 'object')
    .map((c, i) => ({
      id: typeof c.id === 'string' && c.id ? c.id.slice(0, 40) : `c${i}`,
      nome: String(c.nome ?? `Microfono ${i + 1}`).slice(0, 40) || `Microfono ${i + 1}`,
      deviceId: typeof c.deviceId === 'string' ? c.deviceId : '',
      parte: c.parte === 'sinistro' || c.parte === 'destro' ? c.parte : 'stereo',
      volumeDb: num(c.volumeDb, DB_MIN, DB_MAX, 0),
      muto: c.muto === true
    })) as Canale[]
  const pc = (x.pc ?? {}) as Partial<ImpostazioniMixer['pc']>
  return {
    canali,
    pc: { attivo: pc.attivo === true, volumeDb: num(pc.volumeDb, DB_MIN, DB_MAX, -6), muto: pc.muto === true, inCuffia: pc.inCuffia === true },
    cuffiaId: typeof x.cuffiaId === 'string' ? x.cuffiaId : '',
    cuffiaVolume: num(x.cuffiaVolume, 0, 1, 0.8),
    ritorno: x.ritorno !== false,
    ritornoVolume: num(x.ritornoVolume, 0, 1, 0.7),
    kbps: ([96, 128, 160, 256] as const).find((k) => k === Number(x.kbps)) ?? 160
  }
}

/** dB → guadagno lineare (−60 dB o meno = silenzio). */
export function guadagno(db: number, muto = false): number {
  if (muto || db <= DB_MIN) return 0
  return Math.pow(10, db / 20)
}
