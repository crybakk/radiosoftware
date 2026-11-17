/**
 * Selezione dei brani da tenere sulla libreria del server (diretta autonoma) e piano di copia.
 *
 * Regole scelte da cristian (15/11/2026):
 *   - si escludono i brani live e le interviste, riconosciuti da "live" / "intervista"
 *     nel titolo, nella cartella o nel genere;
 *   - si escludono i file sotto i 192 kbps (soglia modificabile);
 *   - ogni brano si può includere o escludere a mano, e la scelta a mano vince.
 * 17/11/2026: la musica più lunga della durata massima (premixati) è nascosta ovunque e non va mai
 * sul server, neanche scelta a mano.
 */
import type { LibraryFolder, Track } from './types'

/** Scelta a mano: null = decide la regola. */
export type ServerChoice = boolean | null

const LIVE_WORD = /\b(live|dal vivo|concerto)\b/i
const INTERVIEW = /\b(intervist[ae]|interview)\b/i

/**
 * Perché un brano resta fuori dal server (null = va sul server secondo le regole).
 * Per il titolo "live" deve sembrare una versione dal vivo ("(Live)", "- Live at...", "Live in Roma"),
 * non l'inizio di un titolo come "Live and Let Die" o "Live Forever".
 */
export function exclusionReason(t: Pick<Track, 'kind' | 'title' | 'genre' | 'path' | 'bitrate' | 'enabled'>, minKbps: number): string | null {
  if (t.kind !== 'music') return 'non è musica'
  if (!t.enabled) return 'file mancante'
  const dirs = t.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  if (INTERVIEW.test(t.title) || INTERVIEW.test(t.genre) || INTERVIEW.test(dirs)) return 'intervista'
  if (LIVE_WORD.test(t.genre)) return 'live (genere)'
  if (LIVE_WORD.test(dirs.split('/').slice(-3).join('/'))) return 'live (cartella)'
  if (liveTitle(t.title)) return 'live (titolo)'
  if (t.bitrate > 0 && t.bitrate < minKbps) return `qualità bassa (${t.bitrate} kbps)`
  return null
}

function liveTitle(title: string): boolean {
  // "(Live)", "[Live 1999]", "- Live", "Live at/in/from ...", "(dal vivo)"
  if (/[([]\s*(live|dal vivo)\b/i.test(title)) return true
  if (/-\s*(live|dal vivo)\b/i.test(title)) return true
  if (/\b(live|dal vivo)\s+(at|in|from|a|al|all'|alla|da)\s+[A-Z0-9]/.test(title)) return true
  // "... Live" in fondo al titolo, ma non un titolo che è solo "Live"
  return /\blive\s*$/i.test(title) && !/^\s*live\s*$/i.test(title)
}

/** Musica più lunga della durata massima in minuti (0 = nessun limite; durata 0 = sconosciuta, non conta). */
export function tooLong(t: Pick<Track, 'kind'> & { duration?: number }, maxMinutes: number): boolean {
  return t.kind === 'music' && maxMinutes > 0 && (t.duration ?? 0) > maxMinutes * 60
}

export function onServer(
  t: Pick<Track, 'kind' | 'title' | 'genre' | 'path' | 'bitrate' | 'enabled'> & { duration?: number },
  choice: ServerChoice,
  minKbps: number,
  maxMinutes = 0
): boolean {
  if (t.kind !== 'music' || !t.enabled || tooLong(t, maxMinutes)) return false
  if (choice !== null) return choice
  return exclusionReason(t, minKbps) === null
}

/**
 * Percorso del brano sul server: "regia/<nome della cartella della libreria>/<percorso dentro la cartella>".
 * Così una copia fatta a mano della cartella (disco USB) finisce nello stesso posto.
 */
export function serverId(path: string, folders: LibraryFolder[]): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = norm(path)
  const win = /^[a-z]:\//i.test(p)
  const cmp = (s: string): string => (win ? s.toLowerCase() : s)
  // la cartella più lunga che contiene il file
  let best: LibraryFolder | null = null
  for (const f of folders) {
    if (f.kind !== 'music') continue
    const fp = norm(f.path)
    if (cmp(p).startsWith(`${cmp(fp)}/`) && (!best || fp.length > norm(best.path).length)) best = f
  }
  if (!best) return null
  const root = norm(best.path)
  const rel = p.slice(root.length + 1)
  return folderPrefix(best) + rel.split('/').map(cleanPart).join('/')
}

/** Inizio dei percorsi sul server dei brani di una cartella della libreria ("regia/<nome>/"). */
export function folderPrefix(f: Pick<LibraryFolder, 'path'>): string {
  const name = f.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || 'musica'
  return `regia/${cleanPart(name)}/`
}

/** Nomi validi anche sul server Linux: niente parti vuote, "..", o che iniziano col punto. */
function cleanPart(s: string): string {
  const c = s.replace(/[\0:]/g, '_').trim()
  if (!c || c === '.' || c === '..') return '_'
  return c.startsWith('.') ? `_${c.slice(1)}` : c
}

/** Correzione di volume per arrivare al volume obiettivo (dB). */
export function gainFor(loudness: number | null, target: number): number {
  if (loudness == null || !Number.isFinite(loudness)) return 0
  return Math.round(Math.max(-20, Math.min(12, target - loudness)) * 10) / 10
}

export interface SyncItem {
  id: string
  size: number
  track: Track
}

/** Oltre questo numero di brani da togliere in una volta, non si toglie nulla finché non lo confermi. */
export const MAX_REMOVE_UNCONFIRMED = 20

/**
 * Cosa caricare e cosa togliere dal server.
 * keep: brani che non sono nella selezione ma non vanno tolti (mancano solo per ora in regia).
 */
export function planSync(
  wanted: SyncItem[],
  remote: { id: string; size: number }[],
  keep: (id: string) => boolean = () => false
): { upload: SyncItem[]; remove: string[] } {
  const there = new Map(remote.map((r) => [r.id, r.size]))
  const want = new Set(wanted.map((w) => w.id))
  return {
    upload: wanted.filter((w) => there.get(w.id) !== w.size),
    remove: remote.filter((r) => !want.has(r.id) && !keep(r.id)).map((r) => r.id)
  }
}
