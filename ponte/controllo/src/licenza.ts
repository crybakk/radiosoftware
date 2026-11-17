/**
 * Chiave di attivazione di regia e server.
 *
 * Una chiave è "RADIO1.<dati>.<firma>": i dati (nome della radio, data) sono firmati con una chiave
 * segreta Ed25519 che resta solo sul PC di chi distribuisce il programma (scripts/crea-chiave.mjs).
 * Qui c'è solo la parte pubblica, che serve a controllare la firma: con questa non si creano chiavi.
 * La stessa chiave vale per la regia e per il server.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto'

/** Parte pubblica della chiave di firma (Ed25519, SPKI in base64). */
const CHIAVE_PUBBLICA = 'MCowBQYDK2VwAyEAf4jSQurcKxBq8+6FDRAtKuqka6nGZwp1/eEhT6livy0='

export const PREFISSO = 'RADIO1'

export interface DatiChiave {
  /** nome della radio a cui è stata data la chiave */
  radio: string
  /** giorno in cui è stata creata (AAAA-MM-GG) */
  creata: string
}

export type EsitoChiave = ({ ok: true } & DatiChiave) | { ok: false; errore: string }

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function chiavePubblica(): KeyObject {
  // solo le prove automatiche la sostituiscono, caricando prima un modulo apposta (vedi prove/chiave-prove.mjs)
  const prova = (globalThis as { __radioChiavePubblicaProve?: string }).__radioChiavePubblicaProve
  return createPublicKey({ key: Buffer.from(prova ?? CHIAVE_PUBBLICA, 'base64'), format: 'der', type: 'spki' })
}

/** Controlla una chiave incollata (spazi e a capo intorno sono ignorati). */
export function verificaChiave(testo: string | undefined | null): EsitoChiave {
  const chiave = (testo ?? '').replace(/\s+/g, '')
  if (!chiave) return { ok: false, errore: 'manca la chiave di attivazione' }
  const parti = chiave.split('.')
  if (parti.length !== 3 || parti[0] !== PREFISSO) return { ok: false, errore: 'la chiave non ha la forma giusta (deve iniziare con RADIO1.)' }
  let firmaOk = false
  try {
    firmaOk = verify(null, Buffer.from(`${parti[0]}.${parti[1]}`), chiavePubblica(), b64url(parti[2]))
  } catch {
    firmaOk = false
  }
  if (!firmaOk) return { ok: false, errore: 'chiave non valida' }
  try {
    const dati = JSON.parse(b64url(parti[1]).toString('utf8')) as Partial<DatiChiave>
    if (typeof dati.radio !== 'string' || typeof dati.creata !== 'string') throw new Error('dati mancanti')
    return { ok: true, radio: dati.radio, creata: dati.creata }
  } catch {
    return { ok: false, errore: 'chiave non valida' }
  }
}
