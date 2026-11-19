/**
 * Pulizia della libreria: brani che non sembrano "radiofonici" (scelto da cristian il 20/11/2026).
 *
 * Non si tolgono da soli: finiscono nella lista "Da controllare" della regia, col motivo, e li togli
 * tu (anche tanti insieme). Un brano tolto resta sul PC: esce solo dalla libreria (rotazioni, ricerca,
 * server). Se vuoi, il file si sposta nella sottocartella CARTELLA_SCARTI della sua cartella musica,
 * che la scansione salta, per cancellarlo a mano quando vuoi.
 */
import { basename, extname, posix, win32 } from 'node:path'
import { exclusionReason } from './serverLibrary'
import type { Track } from './types'

/** Sottocartella (dentro la cartella della musica) dove vanno i file tolti dalla libreria. */
export const CARTELLA_SCARTI = '_Tolti dalla libreria'

/** Titoli generici dei CD rippati o dei lettori: "Track 01", "Traccia 3", "Piste 12", "AudioTrack 05". */
const TRACCIA = /^\s*(\d{1,3}\s*[-._]?\s*)?(track|traccia|pista|piste|titre|audio\s*track|audiotrack|tr)\s*[-._#]?\s*\d{1,3}\b/i
/** Titoli che non sono titoli: vuoti o "sconosciuto", "untitled", "senza titolo", "nuovo". */
const SENZA_TITOLO = /^\s*(untitled|unknown|sconosciuto|senza titolo|no title|unknown title|traccia|track|brano|-+|\?+)\s*\d*\s*$/i
/** Registrazioni e file grezzi: "REC_0012", "Registrazione 5", "Voice 003", "New Recording 4", "AUD-20190504". */
const REGISTRAZIONE =
  /^\s*(rec|registrazione|nuova registrazione|recording|new recording|voice|memo|vocale|aud|audio|ptt|zoom)\s*[-._ ]*\d[\d\s\-._]*$/i
/** "live@...", "Live @ Rock in Rio": esibizioni dal vivo scritte come nei siti dei DJ set. */
const LIVE_AT = /\blive\s*@/i
/** Data o ora nel titolo come nei file registrati: 2019-05-04, 20190504_1830, 04.05.2019. */
const DATA_FILE = /(\b(19|20)\d{2}[-._]?[01]\d[-._]?[0-3]\d\b)|(\b[0-3]\d[-._][01]\d[-._](19|20)\d{2}\b)/
/** Nomi file lasciati nel titolo: estensione o tanti trattini bassi. */
const NOME_FILE = /\.(mp3|wav|m4a|aac|flac|ogg|wma)\s*$/i

type PerPulizia = Pick<Track, 'kind' | 'title' | 'artist' | 'genre' | 'path' | 'bitrate' | 'enabled'>

/**
 * Perché un brano sembra non adatto alla messa in onda (null = sembra a posto).
 * Solo la musica: jingle, notiziari e il resto hanno nomi liberi.
 */
export function motivoNonRadiofonico(t: PerPulizia): string | null {
  if (t.kind !== 'music') return null
  const title = (t.title ?? '').trim()
  const file = basename(t.path.replace(/\\/g, '/'))
  const name = basename(file, extname(file))
  if (LIVE_AT.test(title) || LIVE_AT.test(name) || LIVE_AT.test(t.path)) return 'live@ (esibizione dal vivo)'
  if (!title) return 'senza titolo'
  if (TRACCIA.test(title)) return 'titolo generico ("Track 01")'
  if (SENZA_TITOLO.test(title)) return 'senza un vero titolo'
  // solo numeri: "1979" o "22" possono essere titoli veri, "01", "3-07" o un numero senza artista no
  if (/^[\d\s\-_.()#]+$/.test(title) && (!t.artist.trim() || /^0\d/.test(title) || /\d[\s\-_.#]+\d/.test(title))) return 'titolo fatto solo di numeri'
  if (REGISTRAZIONE.test(title)) return 'sembra una registrazione, non un brano'
  if (NOME_FILE.test(title)) return 'nome del file al posto del titolo'
  if (DATA_FILE.test(title) && !t.artist.trim()) return 'nome del file al posto del titolo'
  if ((title.match(/_/g) ?? []).length >= 2 && !/\s/.test(title)) return 'nome del file al posto del titolo'
  // le regole che già tengono fuori dal server live e interviste (la qualità bassa no: non è un titolo)
  const ex = exclusionReason({ ...t, enabled: true }, 0)
  if (ex && (ex.startsWith('live') || ex === 'intervista')) return ex
  return null
}

/**
 * Dove spostare un file tolto dalla libreria: dentro la sua cartella della musica, nella sottocartella
 * degli scarti, mantenendo le sottocartelle (così si capisce da dove viene). null = file fuori dalle cartelle.
 */
export function percorsoScarto(path: string, cartelle: string[]): string | null {
  const win = /^[a-z]:[\\/]/i.test(path) || path.includes('\\')
  const P = win ? win32 : posix
  const cmp = (s: string): string => (win ? s.toLowerCase().replace(/\//g, '\\') : s)
  const trim = (s: string): string => s.replace(/[\\/]+$/, '')
  let best: string | null = null
  for (const c of cartelle) {
    const root = trim(c)
    if (cmp(path).startsWith(cmp(root) + P.sep) && (!best || root.length > best.length)) best = root
  }
  if (!best) return null
  const rel = path.slice(best.length + 1)
  if (!rel) return null
  // già negli scarti: resta dov'è
  if (rel.split(/[\\/]/)[0] === CARTELLA_SCARTI) return null
  return P.join(best, CARTELLA_SCARTI, rel)
}

/** Il percorso è dentro una cartella degli scarti (la scansione la salta). */
export function negliScarti(path: string): boolean {
  return path.split(/[\\/]/).includes(CARTELLA_SCARTI)
}


const senzaAccenti = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Aggiunte al titolo che non cambiano il brano: "(Remastered 2011)", "[2009 Remaster]", "(Album Version)". */
const AGGIUNTE =
  /[([]\s*[^)\]]*\b(remaster(ed)?|rimasterizzat[oa]|album version|single version|explicit|bonus track|versione album|lp version|mono|stereo)\b[^)\]]*[)\]]/gi

/**
 * Chiave dei doppioni: artista e titolo senza maiuscole, accenti, punteggiatura e aggiunte tipo "Remastered".
 * Remix, live, edit e versioni diverse restano brani diversi. '' = brano senza artista o titolo (non si confronta).
 */
export function chiaveDoppione(t: Pick<Track, 'title' | 'artist'>): string {
  const pulisci = (s: string): string =>
    senzaAccenti(s.replace(AGGIUNTE, ' '))
      .replace(/\s+-\s+(\d{4}\s+)?remaster(ed)?(\s+\d{4})?\s*$/i, '')
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  const a = pulisci(t.artist)
  const ti = pulisci(t.title)
  return a && ti ? `${a}\u0000${ti}` : ''
}

/**
 * La copia da tenere tra i doppioni: qualità più alta, poi quella già analizzata (volume e punti di mix),
 * poi la più lunga (le versioni tagliate male sono più corte), poi la più vecchia in libreria.
 */
export function copiaDaTenere<T extends Pick<Track, 'id' | 'bitrate' | 'duration' | 'analyzedAt'>>(copie: T[]): T {
  return [...copie].sort(
    (a, b) =>
      b.bitrate - a.bitrate ||
      Number(b.analyzedAt != null) - Number(a.analyzedAt != null) ||
      Math.round(b.duration) - Math.round(a.duration) ||
      a.id - b.id
  )[0]
}
