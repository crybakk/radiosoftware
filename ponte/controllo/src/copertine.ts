/**
 * Copertine dei brani in onda per il player pubblico e per l'app (richiesta di cristian, 17/11/2026).
 * Si usano servizi già pronti e gratuiti, senza chiavi: prima la ricerca di iTunes (Apple), poi Deezer.
 * Si cerca una volta sola per brano (artista + titolo); l'immagine si salva nella cartella dati
 * (copertine/<chiave>.jpg) e si serve da GET /api/copertina/<chiave>.jpg. Anche i brani senza
 * copertina si ricordano (per un giorno), così non si richiede di continuo.
 * Al servizio va solo artista e titolo del brano in onda, cioè quello che è già pubblico.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>

const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const MISS_TTL_MS = 24 * 3600_000
const TIMEOUT_MS = 6000

/** Testo confrontabile: minuscole, senza accenti e punteggiatura. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Stesso artista? Basta che uno contenga l'altro ("Lucio Dalla" ~ "Lucio Dalla & Gianni Morandi"). */
export function sameArtist(a: string, b: string): boolean {
  const x = normalize(a)
  const y = normalize(b)
  return !!x && !!y && (x.includes(y) || y.includes(x))
}

export const coverKey = (artist: string, title: string): string =>
  createHash('md5').update(`${normalize(artist)}|${normalize(title)}`).digest('hex')

/** Indirizzo della copertina più grande dai risultati di iTunes (null se non c'è o è di un altro artista). */
export function fromItunes(data: unknown, artist: string): string | null {
  const results = (data as { results?: { artistName?: string; artworkUrl100?: string }[] })?.results
  if (!Array.isArray(results)) return null
  const r = results.find((x) => typeof x?.artworkUrl100 === 'string' && sameArtist(x.artistName ?? '', artist))
  // le immagini di iTunes esistono in più misure: si chiede la 600x600
  return r ? r.artworkUrl100!.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.jpg') : null
}

/** Indirizzo della copertina dai risultati di Deezer. */
export function fromDeezer(data: unknown, artist: string): string | null {
  const results = (data as { data?: { artist?: { name?: string }; album?: { cover_xl?: string; cover_big?: string } }[] })?.data
  if (!Array.isArray(results)) return null
  const r = results.find((x) => (x?.album?.cover_xl || x?.album?.cover_big) && sameArtist(x.artist?.name ?? '', artist))
  return r ? (r.album!.cover_xl || r.album!.cover_big)! : null
}

/** JPEG o PNG veri (si controllano i primi byte). */
export function isImage(b: Buffer): boolean {
  return (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
}

export class CoverArt {
  private misses = new Map<string, number>()
  private pending = new Map<string, Promise<boolean>>()

  private dir: string
  private fetchFn: Fetch
  private now: () => number

  constructor(dir: string, fetchFn: Fetch = fetch as unknown as Fetch, now: () => number = Date.now) {
    this.dir = dir
    this.fetchFn = fetchFn
    this.now = now
  }

  file(key: string): string {
    return join(this.dir, `${key}.jpg`)
  }

  /** Chiave della copertina se è già stata trovata, altrimenti null. */
  ready(artist: string, title: string): string | null {
    if (!artist.trim() || !title.trim()) return null
    const key = coverKey(artist, title)
    return existsSync(this.file(key)) ? key : null
  }

  /** Cerca e salva la copertina (una ricerca alla volta per brano). true se c'è. */
  lookup(artist: string, title: string): Promise<boolean> {
    if (!artist.trim() || !title.trim()) return Promise.resolve(false)
    const key = coverKey(artist, title)
    if (existsSync(this.file(key))) return Promise.resolve(true)
    const missAt = this.misses.get(key)
    if (missAt !== undefined && this.now() - missAt < MISS_TTL_MS) return Promise.resolve(false)
    let p = this.pending.get(key)
    if (!p) {
      p = this.find(artist, title, key)
        .catch((e) => {
          console.log(`[copertine] ${artist} - ${title}: ${e instanceof Error ? e.message : String(e)}`)
          return false
        })
        .then((ok) => {
          this.pending.delete(key)
          if (!ok) this.misses.set(key, this.now())
          // la memoria dei brani senza copertina non cresce all'infinito
          if (this.misses.size > 5000) this.misses.delete(this.misses.keys().next().value!)
          return ok
        })
      this.pending.set(key, p)
    }
    return p
  }

  private async getJson(url: string): Promise<unknown> {
    const r = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) throw new Error(`risposta ${r.status}`)
    return r.json()
  }

  private async find(artist: string, title: string, key: string): Promise<boolean> {
    const term = encodeURIComponent(`${artist} ${title}`)
    let url: string | null = null
    try {
      url = fromItunes(await this.getJson(`https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${term}`), artist)
    } catch {
      // si prova con Deezer
    }
    if (!url) {
      const q = encodeURIComponent(`artist:"${artist.replace(/"/g, '')}" track:"${title.replace(/"/g, '')}"`)
      url = fromDeezer(await this.getJson(`https://api.deezer.com/search?limit=5&q=${q}`), artist)
    }
    if (!url || !/^https:\/\//.test(url)) return false
    const r = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) return false
    const img = Buffer.from(await r.arrayBuffer())
    if (img.length > MAX_IMAGE_BYTES || !isImage(img)) return false
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file(key)}.part`
    writeFileSync(tmp, img)
    renameSync(tmp, this.file(key))
    return true
  }
}
