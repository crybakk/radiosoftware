/**
 * Registro dei brani suonati dal server (diretta autonoma, musica di riserva, e in futuro le esterne
 * riconosciute). La regia lo scarica e lo unisce al suo registro di trasmissione per il report SIAE.
 * Un file JSON per riga, in ordine di tempo; si tengono 400 giorni.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export type PlaySource = 'autonoma' | 'riserva' | 'esterna'

export interface ServerPlay {
  /** Inizio (ISO). */
  at: string
  source: PlaySource
  /** Percorso nella libreria del server ("regia/...", "caricati/..."); vuoto se sconosciuto. */
  id: string
  title: string
  artist: string
  duration: number
}

const KEEP_DAYS = 400

export class PlayLog {
  private readonly file: string
  private readonly now: () => number

  constructor(file: string, now: () => number = () => Date.now()) {
    this.file = file
    this.now = now
    this.prune()
  }

  add(p: Omit<ServerPlay, 'at'> & { at?: string }): ServerPlay {
    const entry: ServerPlay = {
      at: p.at ?? new Date(this.now()).toISOString(),
      source: p.source,
      id: p.id,
      title: p.title,
      artist: p.artist,
      duration: Math.round(p.duration * 10) / 10
    }
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
    return entry
  }

  private read(): ServerPlay[] {
    if (!existsSync(this.file)) return []
    const out: ServerPlay[] = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as ServerPlay)
      } catch {
        // riga rovinata (per esempio spegnimento a metà scrittura): si salta
      }
    }
    return out
  }

  /** Voci con inizio in [from, to). */
  list(from: Date, to: Date): ServerPlay[] {
    const a = from.toISOString()
    const b = to.toISOString()
    return this.read().filter((p) => p.at >= a && p.at < b)
  }

  private prune(): void {
    const all = this.read()
    const limit = new Date(this.now() - KEEP_DAYS * 86400_000).toISOString()
    const keep = all.filter((p) => p.at >= limit)
    if (keep.length === all.length) return
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, keep.map((p) => JSON.stringify(p)).join('\n') + (keep.length ? '\n' : ''))
    renameSync(tmp, this.file)
  }
}
