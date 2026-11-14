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

async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* walk(full)
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
 */
export async function scanLibrary(db: RadioDb, onProgress?: (p: ScanProgress) => void): Promise<ScanProgress> {
  const folders = db.listFolders()
  const seenPaths = new Set<string>()
  const progress: ScanProgress = { folder: '', seen: 0, added: 0, updated: 0, errors: 0, disabled: 0, done: false }
  for (const folder of folders) {
    progress.folder = folder.path
    for await (const file of walk(resolve(folder.path))) {
      seenPaths.add(file)
      progress.seen++
      try {
        const st = await stat(file)
        const prev = db.fileState(file)
        if (prev && prev.size === st.size && Math.abs(prev.mtime - st.mtimeMs) < 1) {
          // non modificato: assicuriamoci solo che sia abilitato e del tipo giusto
          db.db.prepare('UPDATE tracks SET enabled = 1, kind = ? WHERE path = ?').run(folder.kind, file)
        } else {
          db.upsertScanned(await readFileInfo(file, folder.kind))
          if (prev) progress.updated++
          else progress.added++
        }
      } catch {
        progress.errors++
      }
      if (progress.seen % 50 === 0) onProgress?.({ ...progress })
    }
  }
  progress.disabled = db.disableMissing(
    seenPaths,
    folders.map((f) => resolve(f.path))
  )
  progress.done = true
  onProgress?.({ ...progress })
  return progress
}
