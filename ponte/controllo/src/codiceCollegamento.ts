/**
 * Codice di collegamento della regia (richiesta di cristian, 26/11/2026: "a prova di anziano").
 *
 * Invece di copiare a mano indirizzo, porte, frase segreta e token dal server, l'amministratore apre nel
 * pannello "Impostazioni server → Collega la regia" e copia un solo codice; nella regia lo si incolla e basta.
 * Il codice è "RADIO-REGIA1.<dati in base64url>": contiene la frase segreta e il token, quindi va trattato
 * come una password. Funziona sia in Node (server) sia nel browser (regia): niente Buffer.
 */

export const PREFISSO_CODICE = 'RADIO-REGIA1'

export interface DatiCollegamento {
  /** Indirizzo internet del server (senza porta). */
  host: string
  /** Porta HTTPS (o HTTP) del pannello e del servizio di controllo, vista da internet. */
  controlPort: number
  controlHttps: boolean
  srtPort: number
  passphrase: string
  controlToken: string
}

const aBase64Url = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const daBase64Url = (s: string): string => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

const porta = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535

export function creaCodice(d: DatiCollegamento): string {
  const dati = { h: d.host, c: d.controlPort, s: d.controlHttps ? 1 : 0, p: d.srtPort, f: d.passphrase, t: d.controlToken }
  return `${PREFISSO_CODICE}.${aBase64Url(JSON.stringify(dati))}`
}

export type EsitoCodice = ({ ok: true } & DatiCollegamento) | { ok: false; errore: string }

/** Legge un codice incollato (spazi e a capo in mezzo vengono ignorati). */
export function leggiCodice(testo: string): EsitoCodice {
  const pulito = testo.replace(/\s+/g, '')
  if (!pulito) return { ok: false, errore: 'Incolla prima il codice di collegamento.' }
  if (pulito.startsWith('RADIO1.'))
    return { ok: false, errore: 'Questa è la chiave di attivazione, non il codice di collegamento. Il codice si copia dal pannello del server: Impostazioni server → Collega la regia.' }
  if (!pulito.startsWith(`${PREFISSO_CODICE}.`))
    return { ok: false, errore: 'Questo non sembra il codice di collegamento: deve iniziare con RADIO-REGIA1. Copialo di nuovo dal pannello del server.' }
  let d: Record<string, unknown>
  try {
    d = JSON.parse(daBase64Url(pulito.slice(PREFISSO_CODICE.length + 1))) as Record<string, unknown>
  } catch {
    return { ok: false, errore: 'Il codice è incompleto: copialo di nuovo dal pannello del server, tutto intero.' }
  }
  if (!d || typeof d.h !== 'string' || !/^[A-Za-z0-9.-]+$/.test(d.h) || !porta(d.c) || !porta(d.p) || typeof d.f !== 'string' || typeof d.t !== 'string' || d.t.length < 16)
    return { ok: false, errore: 'Il codice è incompleto: copialo di nuovo dal pannello del server, tutto intero.' }
  return { ok: true, host: d.h, controlPort: d.c, controlHttps: d.s === 1, srtPort: d.p, passphrase: d.f, controlToken: d.t }
}

/** true se l'indirizzo è di casa (rete locale): da fuori non funzionerebbe. */
export function indirizzoLocale(host: string): boolean {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.fritz.box')
}
