/**
 * Flusso HLS (scelte di cristian, 17/11/2026): Liquidsoap scrive in memoria tre qualità AAC (64, 128 e
 * 192 kbit/s) a pezzi da 6 secondi. Gli indirizzi sono quelli di AzuraCast: /hls/<stazione>/live.m3u8.
 * Caddy manda i pezzi audio (.ts); le playlist passano da qui, così si contano gli ascoltatori: chi chiede
 * la playlist di una qualità la richiede ogni pochi secondi finché ascolta.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Dopo quanto senza richieste un ascoltatore HLS non si conta più (la playlist si rilegge ogni ~6 s). */
const ATTIVO_MS = 30_000

/** Ascoltatori HLS: uno per indirizzo e browser, finché richiedono la playlist. */
export class HlsListeners {
  private seen = new Map<string, number>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  hit(ip: string, userAgent: string): void {
    const k = createHash('sha1').update(`${ip}\n${userAgent}`).digest('hex')
    this.seen.set(k, this.now())
    if (this.seen.size > 50_000) this.prune()
  }

  private prune(): void {
    const t = this.now()
    for (const [k, at] of this.seen) if (t - at > ATTIVO_MS) this.seen.delete(k)
  }

  count(): number {
    this.prune()
    return this.seen.size
  }
}

/** Nome di playlist accettato: live.m3u8 (principale) o quella di una qualità (aac_midfi.m3u8). */
export function hlsPlaylistName(path: string, station: string): string | null {
  const m = /^\/hls\/([^/]+)\/([A-Za-z0-9_]+\.m3u8)$/.exec(path)
  if (!m) return null
  // come AzuraCast: il nome breve della stazione, oppure "1"
  if (m[1] !== station && m[1] !== '1') return null
  return m[2]
}

/** Playlist letta dalla cartella HLS; null se non c'è (flusso spento o appena partito). */
export async function readHlsPlaylist(dir: string, name: string): Promise<string | null> {
  return readFile(join(dir, name), 'utf8').catch(() => null)
}

/** Le playlist di una qualità (non quella principale) dicono che qualcuno sta ascoltando. */
export const isVariantPlaylist = (name: string): boolean => name !== 'live.m3u8'
