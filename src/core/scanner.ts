import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type { RadioDb, ScannedFile } from './db'
import type { TrackKind } from './types'

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus'])

export interface ScanProgress {
  folder: string
  seen: number
  added: number
  updated: number
  errors: number
  disabled: number
  done: boolean
}

/** Errore per i file con estensione audio che non contengono audio (vuoti, rovinati, rinominati). */
export class NotAudioError extends Error {
  constructor(path: string) {
    super(`Il file non contiene audio leggibile: ${path}`)
  }
}

/** Elenca i file audio sotto `dir`. Le cartelle che non si possono leggere finiscono in `unreadable`. */
async function* walk(dir: string, unreadable: string[]): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    unreadable.push(dir)
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* walk(full, unreadable)
    else if (e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase())) yield full
  }
}

/** "Artista - Titolo.mp3" → { artist, title } quando i tag mancano. */
export function guessFromFilename(file: string): { artist: string; title: string } {
  const base = file.split(/[\\/]/).pop() ?? file
  const name = basename(base, extname(base)).replace(/_/g, ' ').trim()
  const cleaned = name.replace(/^\d{1,3}[\s.\-_]+/, '')
  const m = cleaned.match(/^(.+?)\s+-\s+(.+)$/)
  if (m) return { artist: m[1].trim(), title: m[2].trim() }
  return { artist: '', title: cleaned }
}

function firstText(v: unknown): string {
  if (Array.isArray(v)) return v.map(firstText).filter(Boolean).join(', ')
  if (v == null) return ''
  if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) return String((v as { text: unknown }).text)
  return String(v)
}

export async function readFileInfo(path: string, kind: TrackKind): Promise<ScannedFile> {
  const st = await stat(path)
  const { parseFile } = await import('music-metadata')
  const meta = await parseFile(path, { duration: false, skipCovers: true })
  // file vuoto o non audio: niente durata e niente frequenza di campionamento
  if (!((meta.format.duration ?? 0) > 0) && !((meta.format.sampleRate ?? 0) > 0)) throw new NotAudioError(path)
  const c = meta.common
  const fallback = guessFromFilename(path)
  const native = meta.native ?? {}
  // ID3v2 TPUB (editore) e TSRC (ISRC) quando non mappati in "common".
  const findNative = (ids: string[]): string => {
    for (const tags of Object.values(native)) {
      for (const t of tags) if (ids.includes(t.id)) return firstText(t.value)
    }
    return ''
  }
  return {
    path,
    kind,
    size: st.size,
    mtime: st.mtimeMs,
    title: (c.title ?? '').trim() || fallback.title,
    artist: (c.artist ?? '').trim() || fallback.artist,
    album: (c.album ?? '').trim(),
    year: c.year ?? null,
    genre: firstText(c.genre),
    composer: firstText(c.composer),
    publisher: firstText(c.label) || findNative(['TPUB', 'PUBLISHER', 'LABEL']),
    isrc: firstText(c.isrc) || findNative(['TSRC', 'ISRC']),
    duration: meta.format.duration ?? 0,
    bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : 0,
    sampleRate: meta.format.sampleRate ?? 0
  }
}

/**
 * Scansiona tutte le cartelle della libreria. I file non modificati vengono saltati,
 * quelli spariti vengono disabilitati (non cancellati, per non perdere lo storico).
 * I brani dentro cartelle che non si riescono a leggere (per esempio un NAS spento) non vengono toccati:
 * ogni cartella illeggibile conta come un errore.
 */
export async function scanLibrary(
  db: RadioDb,
  onProgress?: (p: ScanProgress) => void,
  // su Windows "canzone.mp3" e "Canzone.mp3" sono lo stesso file
  caseInsensitive = process.platform === 'win32'
): Promise<ScanProgress> {
  const folders = db.listFolders()
  const seenPaths = new Set<string>()
  const unreadable: string[] = []
  const progress: ScanProgress = { folder: '', seen: 0, added: 0, updated: 0, errors: 0, disabled: 0, done: false }
  // i brani aggiunti da altri durante la scansione (download dal server, playlist) non vanno disabilitati
  const lastId = db.lastTrackId()
  for (const folder of folders) {
    progress.folder = folder.path
    const before = unreadable.length
    for await (const file of walk(resolve(folder.path), unreadable)) {
      seenPaths.add(file)
      progress.seen++
      try {
        const st = await stat(file)
        // file rinominato cambiando solo maiuscole/minuscole: resta lo stesso brano (correzioni, tipo, storico)
        if (caseInsensitive && !db.fileState(file)) {
          const old = db.findByPath(file, true)
          if (old && old.path !== file) db.renameTrackPath(old.id, file)
        }
        const prev = db.fileState(file)
        const unchanged = prev && prev.size === st.size && Math.abs(prev.mtime - st.mtimeMs) < 1
        const info = unchanged ? null : await readFileInfo(file, folder.kind)
        // cartella tolta dalla libreria durante la scansione: i suoi brani restano disabilitati
        if (!db.listFolders().some((f) => f.id === folder.id)) break
        if (!info) {
          // non modificato: riabilitato se era sparito, tipo della cartella se non cambiato a mano
          db.refreshUnchanged(file, folder.kind)
        } else {
          db.upsertScanned(info)
          if (prev) progress.updated++
          else progress.added++
        }
      } catch (e) {
        progress.errors++
        // un file non audio non va in onda: se era in libreria viene disabilitato come se fosse sparito
        if (e instanceof NotAudioError) seenPaths.delete(file)
      }
      if (progress.seen % 50 === 0) onProgress?.({ ...progress })
    }
    progress.errors += unreadable.length - before
  }
  progress.disabled = db.disableMissing(
    seenPaths,
    folders.map((f) => resolve(f.path)),
    unreadable,
    lastId
  )
  progress.done = true
  onProgress?.({ ...progress })
  return progress
}
