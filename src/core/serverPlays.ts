/**
 * Brani suonati dal server quando la regia non è in onda (diretta autonoma, musica di riserva):
 * si scaricano dal ponte e si aggiungono al registro di trasmissione, così finiscono nel report SIAE.
 */
import type { RadioDb } from './db'
import type { PonteClient, ServerPlay } from './ponteClient'
import { serverId } from './serverLibrary'
import type { Track } from './types'

/** Il ponte tiene 400 giorni: al primo collegamento si prende tutto quello che c'è. */
const FIRST_IMPORT_DAYS = 400
/** Si riscarica anche un po' di prima dell'ultimo passaggio importato, per sicurezza (i doppioni si scartano). */
const OVERLAP_MS = 24 * 3600_000

export function extId(p: ServerPlay): string {
  return `server:${p.source}:${p.at}:${p.id}`
}

/** Percorso sul server → brano della libreria della regia. */
export function serverIndex(db: RadioDb): Map<string, Track> {
  const folders = db.listFolders()
  const map = new Map<string, Track>()
  for (const { track } of db.musicForServer()) {
    const id = serverId(track.path, folders)
    if (id && !map.has(id)) map.set(id, track)
  }
  return map
}

/** Aggiunge al registro i passaggi nuovi. Restituisce quanti ne ha aggiunti. */
export function importPlays(db: RadioDb, plays: ServerPlay[], index: Map<string, Track>): number {
  let added = 0
  for (const p of plays) {
    if (!p.at || !p.source) continue
    const track = (p.id && index.get(p.id)) || null
    const ok = db.importPlay({
      extId: extId(p),
      startedAt: p.at,
      seconds: Number(p.duration) || 0,
      source: p.source,
      track,
      title: p.title ?? '',
      artist: p.artist ?? '',
      composer: p.composer ?? '',
      publisher: p.publisher ?? ''
    })
    if (ok) added++
  }
  return added
}

/** Scarica dal ponte e importa. */
export async function syncServerPlays(db: RadioDb, client: PonteClient, now = new Date()): Promise<number> {
  const last = db.lastServerPlay()
  const from = last
    ? new Date(new Date(last).getTime() - OVERLAP_MS)
    : new Date(now.getTime() - FIRST_IMPORT_DAYS * 86400_000)
  const plays = await client.listPlays(from, new Date(now.getTime() + 60_000))
  if (!plays.length) return 0
  return importPlays(db, plays, serverIndex(db))
}
