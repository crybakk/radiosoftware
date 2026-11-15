/**
 * Brani caricati dal pannello sul server: la regia li scarica e li cataloga nella cartella della musica
 * come "Artista\Titolo.mp3" (scelta di cristian, 15/11/2026).
 */
import { extname } from 'node:path'

/** Nome valido su Windows: niente caratteri vietati, punti o spazi in fondo, nomi riservati. */
export function safeFileName(s: string, fallback: string): string {
  let c = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim()
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(c)) c = `${c}_`
  return c || fallback
}

/** Percorso relativo nella cartella della musica: ["Artista", "Titolo.ext"]. */
export function catalogParts(t: { id: string; title: string; artist: string }): [string, string] {
  const ext = extname(t.id).toLowerCase() || '.mp3'
  const base = t.id.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
  return [safeFileName(t.artist, 'Artista sconosciuto'), `${safeFileName(t.title, safeFileName(base, 'Senza titolo'))}${ext}`]
}

/** Se il nome è già preso da un altro file: "Titolo (2).mp3", "Titolo (3).mp3"… */
export function withCounter(name: string, n: number): string {
  if (n <= 1) return name
  const ext = extname(name)
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`
}
