/**
 * Libreria musicale del server (cartella /musica): indice con titolo, artista, durata e qualità.
 * Serve alla diretta autonoma, che suona dal server senza la regia.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { parseFile } from 'music-metadata'

export interface ServerTrack {
  /** Percorso relativo alla cartella della libreria (con "/"). */
  id: string
  title: string
  artist: string
  duration: number
  /** kbit/s (0 = sconosciuto) */
  bitrate: number
  /** Correzione di volume in dB (dalla regia, che conosce il volume misurato); 0 = nessuna. */
  gainDb: number
  mtime: number
  size: number
}

/** Dati che la regia conosce meglio dei tag del file (titolo corretto, volume misurato). */
export interface StudioMeta {
  title?: string
  artist?: string
  duration?: number
  gainDb?: number
}

export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav'])

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile() && AUDIO_EXT.has(extname(e.name).toLowerCase())) yield p
  }
}

/** Titolo e artista dal nome del file "Artista - Titolo.mp3", se mancano i tag. */
export function guessFromName(file: string): { artist: string; title: string } {
  const name = basename(file, extname(file)).replace(/_/g, ' ').trim()
  const i = name.indexOf(' - ')
  return i > 0 ? { artist: name.slice(0, i).trim(), title: name.slice(i + 3).trim() } : { artist: '', title: name }
}

const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

export class Library {
  private tracks = new Map<string, ServerTrack>()
  private scanning: Promise<number> | null = null
  readonly root: string
  private readonly indexFile: string

  constructor(root: string, indexFile: string) {
    this.root = root
    this.indexFile = indexFile
    if (existsSync(indexFile)) {
      try {
        for (const t of JSON.parse(readFileSync(indexFile, 'utf8')) as ServerTrack[]) this.tracks.set(t.id, t)
      } catch {
        // indice rovinato: si rifà con la prossima scansione
      }
    }
  }

  isScanning(): boolean {
    return this.scanning !== null
  }

  count(): number {
    return this.tracks.size
  }

  get(id: string): ServerTrack | undefined {
    return this.tracks.get(id)
  }

  /** Brano dal percorso completo del file (quello che usa Liquidsoap). */
  byPath(file: string): ServerTrack | undefined {
    const rel = relative(this.root, file).split(sep).join('/')
    return rel.startsWith('..') ? undefined : this.tracks.get(rel)
  }

  all(): ServerTrack[] {
    return [...this.tracks.values()]
  }

  /** Percorso completo del file (lo stesso dentro il contenitore di Liquidsoap). */
  path(t: ServerTrack): string {
    return join(this.root, ...t.id.split('/'))
  }

  /** Cerca nella cartella: aggiunge i file nuovi o cambiati, toglie quelli spariti. */
  scan(): Promise<number> {
    this.scanning ??= this.doScan().finally(() => (this.scanning = null))
    return this.scanning
  }

  private async doScan(): Promise<number> {
    const seen = new Set<string>()
    for await (const file of walk(this.root)) {
      const id = relative(this.root, file).split(sep).join('/')
      seen.add(id)
      const st = await stat(file).catch(() => null)
      if (!st) continue
      const old = this.tracks.get(id)
      if (old && old.mtime === st.mtimeMs && old.size === st.size) continue
      await this.addFile(file)
    }
    for (const id of this.tracks.keys()) if (!seen.has(id)) this.tracks.delete(id)
    this.save()
    return this.tracks.size
  }

  /** Legge i tag di un file e lo mette nell'indice (con i dati della regia, se ci sono). */
  async addFile(file: string, meta: StudioMeta = {}): Promise<ServerTrack> {
    const id = relative(this.root, file).split(sep).join('/')
    const st = await stat(file)
    const guess = guessFromName(file)
    let title = guess.title
    let artist = guess.artist
    let duration = 0
    let bitrate = 0
    try {
      const m = await parseFile(file, { duration: true, skipCovers: true })
      title = m.common.title?.trim() || title
      artist = m.common.artist?.trim() || artist
      duration = m.format.duration ?? 0
      bitrate = Math.round((m.format.bitrate ?? 0) / 1000)
    } catch {
      // file non leggibile: restano i dati dal nome
    }
    const t: ServerTrack = { id, title, artist, duration, bitrate, gainDb: 0, mtime: st.mtimeMs, size: st.size }
    this.tracks.set(id, t)
    this.setMeta(id, meta)
    return t
  }

  setMeta(id: string, meta: StudioMeta): boolean {
    const t = this.tracks.get(id)
    if (!t) return false
    if (meta.title) t.title = meta.title
    if (meta.artist) t.artist = meta.artist
    if (meta.duration && meta.duration > 0) t.duration = meta.duration
    if (meta.gainDb != null && Number.isFinite(meta.gainDb)) t.gainDb = Math.max(-20, Math.min(20, meta.gainDb))
    return true
  }

  remove(id: string): void {
    this.tracks.delete(id)
  }

  save(): void {
    const tmp = `${this.indexFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.all()))
    renameSync(tmp, this.indexFile)
  }

  search(q: string, limit = 50): ServerTrack[] {
    const words = norm(q).split(/\s+/).filter(Boolean)
    const out: ServerTrack[] = []
    for (const t of this.tracks.values()) {
      const hay = norm(`${t.artist} ${t.title}`)
      if (words.every((w) => hay.includes(w))) out.push(t)
      if (out.length >= limit) break
    }
    return out.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title))
  }

  /**
   * Un brano a caso che non sia passato di recente e il cui artista non sia tra gli ultimi.
   * Se la libreria è piccola, le regole si allentano invece di fermare la musica.
   */
  pickRandom(recentIds: string[], recentArtists: string[], rnd: () => number = Math.random): ServerTrack | null {
    const all = this.all().filter((t) => t.duration === 0 || t.duration > 60)
    if (!all.length) return null
    const ids = new Set(recentIds)
    const artists = new Set(recentArtists.map(norm).filter(Boolean))
    const tiers = [
      all.filter((t) => !ids.has(t.id) && !artists.has(norm(t.artist))),
      all.filter((t) => !ids.has(t.id)),
      all
    ]
    const pool = tiers.find((p) => p.length) ?? all
    return pool[Math.floor(rnd() * pool.length)]
  }
}
