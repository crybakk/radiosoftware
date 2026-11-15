/**
 * Registro dei brani suonati dal server (diretta autonoma, musica di riserva, esterne riconosciute). La regia lo scarica e lo unisce al suo registro di trasmissione per il report SIAE.
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
  /**
   * Quando è stata scritta la voce (ISO), solo se diversa dall'inizio: un brano sconosciuto etichettato dopo giorni
   * aggiunge passaggi vecchi, che la regia deve scaricare anche se cerca solo le voci recenti.
   */
  added?: string
  /** Solo per i brani sconosciuti etichettati dal pannello (gli altri li conosce la regia). */
  composer?: string
  publisher?: string
}

const KEEP_DAYS = 400
/** Il server resta acceso per mesi: le voci vecchie si tolgono anche mentre gira, una volta al giorno. */
const PRUNE_EVERY_MS = 86400_000

export class PlayLog {
  private readonly file: string
  private readonly now: () => number
  private lastPrune = 0
  /** Avviso a ogni brano aggiunto (titolo in onda). */
  onAdd: ((e: ServerPlay) => void) | null = null

  constructor(file: string, now: () => number = () => Date.now()) {
    this.file = file
    this.now = now
    this.prune()
  }

  add(p: Omit<ServerPlay, 'at' | 'added'> & { at?: string }): ServerPlay {
    const now = new Date(this.now()).toISOString()
    const entry: ServerPlay = {
      at: p.at ?? now,
      ...(p.at && p.at !== now ? { added: now } : {}),
      source: p.source,
      id: p.id,
      title: p.title,
      artist: p.artist,
      duration: Math.round(p.duration * 10) / 10,
      ...(p.composer ? { composer: p.composer } : {}),
      ...(p.publisher ? { publisher: p.publisher } : {})
    }
    try {
      if (this.now() - this.lastPrune > PRUNE_EVERY_MS) this.prune()
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
    } catch (e) {
      // disco pieno o simili: si perde la voce ma non si ferma chi suona (eventi, riconoscimento)
      console.error(`[registro] voce non salvata: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.onAdd?.(entry)
    return entry
  }

  private read(): ServerPlay[] {
    if (!existsSync(this.file)) return []
    const out: ServerPlay[] = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const p = JSON.parse(line) as ServerPlay | null
        if (p && typeof p === 'object' && typeof p.at === 'string') out.push(p)
      } catch {
        // riga rovinata (per esempio spegnimento a metà scrittura): si salta
      }
    }
    return out
  }

  /** Voci con inizio in [from, to), più quelle scritte in [from, to) con un inizio precedente. */
  list(from: Date, to: Date): ServerPlay[] {
    const a = from.toISOString()
    const b = to.toISOString()
    const inside = (t: string | undefined): boolean => typeof t === 'string' && t >= a && t < b
    return this.read().filter((p) => inside(p.at) || inside(p.added))
  }

  private prune(): void {
    this.lastPrune = this.now()
    const all = this.read()
    const limit = new Date(this.now() - KEEP_DAYS * 86400_000).toISOString()
    const keep = all.filter((p) => p.at >= limit)
    if (keep.length === all.length) return
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, keep.map((p) => JSON.stringify(p)).join('\n') + (keep.length ? '\n' : ''))
    renameSync(tmp, this.file)
  }
}
