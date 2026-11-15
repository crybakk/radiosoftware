/**
 * Brani caricati dal pannello sul server: la regia li scarica e li cataloga nella cartella della musica
 * come "Artista\Titolo.mp3" (scelta di cristian, 15/11/2026).
 */
import { extname } from 'node:path'

/** Nome valido su Windows: niente caratteri vietati, punti o spazi in fondo, nomi riservati. */
export function safeFileName(s: string, fallback: string): string {
  const clean = (x: string): string => x.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  // a 120 caratteri senza spezzare le lettere fatte di due parti (emoji); dopo il taglio può
  // tornare un punto o uno spazio in fondo, che Windows non accetta
  let c = clean([...clean(s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' '))].slice(0, 120).join(''))
  // nomi riservati anche con un'estensione dopo ("CON.mp3", "nul.live.mp3")
  c = c.replace(/^(con|prn|aux|nul|conin\$|conout\$|com\d|lpt\d)(?=\s*(\.|$))/i, '$1_')
  return c || fallback
}

/** Percorso relativo nella cartella della musica: ["Artista", "Titolo.ext"]. */
export function catalogParts(t: { id: string; title: string; artist: string }): [string, string] {
  // estensione dal server: solo lettere e numeri (niente ":" o altro che Windows legge in modo speciale)
  const e = extname(t.id).toLowerCase()
  const ext = /^\.[a-z0-9]{1,5}$/.test(e) ? e : '.mp3'
  const base = t.id.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
  return [safeFileName(t.artist, 'Artista sconosciuto'), `${safeFileName(t.title, safeFileName(base, 'Senza titolo'))}${ext}`]
}

/** Se il nome è già preso da un altro file: "Titolo (2).mp3", "Titolo (3).mp3"… */
export function withCounter(name: string, n: number): string {
  if (n <= 1) return name
  const ext = extname(name)
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`
}
