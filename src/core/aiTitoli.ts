/**
 * Giudizio dei titoli con l'AI locale della regia: quali brani non sembrano adatti alla messa in onda.
 * Il modello vede solo artista, titolo e cartella (niente audio) e può scegliere solo tra motivi fissi;
 * i brani segnalati finiscono nella lista "Da controllare" e decidi tu.
 */
import type { Track } from './types'

export const MOTIVI_AI = [
  'non è un vero titolo',
  'esibizione dal vivo',
  'intervista o parlato',
  'registrazione o file grezzo',
  'mix o DJ set',
  'karaoke o base strumentale',
  'jingle, spot o sigla',
  'suoneria o effetto sonoro'
] as const

export const BATCH_TITOLI = 30

export const SYSTEM_TITOLI = `Sei il responsabile musicale di una radio italiana. Ricevi un elenco numerato di file musicali
(artista, titolo e cartella). Devi trovare SOLO quelli che chiaramente non sono canzoni da mandare in onda:
titoli che non sono titoli (nomi di tracce, codici, nomi di file), esibizioni dal vivo, interviste o parlato,
registrazioni grezze, mix o DJ set, karaoke o basi, jingle/spot/sigle, suonerie o effetti.
Una canzone normale, anche con un titolo strano, breve, in un'altra lingua o con numeri, va lasciata stare.
Remix, versioni radio, edit, remaster e featuring sono canzoni normali. Nel dubbio NON segnalare.
Rispondi solo con il JSON richiesto: l'elenco dei numeri da segnalare con il motivo (vuoto se sono tutte canzoni).`

export function schemaTitoli(): object {
  return {
    type: 'object',
    properties: {
      segnalati: {
        type: 'array',
        items: {
          type: 'object',
          properties: { n: { type: 'integer' }, motivo: { enum: [...MOTIVI_AI] } },
          required: ['n', 'motivo']
        }
      }
    },
    required: ['segnalati']
  }
}

/** Ultime due cartelle del percorso: aiutano (es. "Live 1999", "Interviste"), il resto è rumore. */
function cartella(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-3, -1).join('/')
}

/** Testo da dare al modello: una riga numerata per brano (da 1). */
export function promptTitoli(tracks: Pick<Track, 'artist' | 'title' | 'path'>[]): string {
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 120)
  return tracks.map((t, i) => `${i + 1}. ${clean(t.artist) || '(artista sconosciuto)'} — ${clean(t.title) || '(senza titolo)'} [${clean(cartella(t.path))}]`).join('\n')
}

/** Dalla risposta del modello al motivo di ogni brano ('' = a posto). Risposta rovinata: errore. */
export function leggiTitoli(raw: string, tracks: Pick<Track, 'id'>[]): { id: number; motivo: string }[] {
  const parsed = JSON.parse(raw) as { segnalati?: unknown }
  if (!parsed || !Array.isArray(parsed.segnalati)) throw new Error('risposta senza elenco')
  const motivi = new Map<number, string>()
  for (const s of parsed.segnalati as { n?: unknown; motivo?: unknown }[]) {
    const n = Number(s?.n)
    const m = String(s?.motivo ?? '')
    if (Number.isInteger(n) && n >= 1 && n <= tracks.length && (MOTIVI_AI as readonly string[]).includes(m)) motivi.set(n, m)
  }
  return tracks.map((t, i) => ({ id: t.id, motivo: motivi.get(i + 1) ?? '' }))
}
