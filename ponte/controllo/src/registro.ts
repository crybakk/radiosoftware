/**
 * Registro dei brani suonati dal server (diretta autonoma, musica di riserva, esterne riconosciute). La regia lo scarica e lo unisce al suo registro di trasmissione per il report SIAE.
 * Un file JSON per riga, in ordine di tempo; si tengono 400 giorni.
 * Per riserva e diretta autonoma la durata è quella suonata davvero (fino al brano dopo o alla fine della
 * sorgente), e i passaggi sotto i 30 secondi non si scrivono.
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
/**
 * Un passaggio della riserva o della diretta autonoma sotto questa durata non va nel registro (brano saltato
 * o interrotto subito), come fa la regia con i suoi (src/core/siae.ts, che il limite lo applica solo ai
 * passaggi della regia).
 */
export const MIN_PLAYED_SECONDS = 30
/** Il server resta acceso per mesi: le voci vecchie si tolgono anche mentre gira, una volta al giorno. */
const PRUNE_EVERY_MS = 86400_000

export class PlayLog {
  private readonly file: string
  private readonly now: () => number
  private lastPrune = 0
  /** Avviso a ogni brano aggiunto o iniziato (titolo in onda). */
  onAdd: ((e: ServerPlay) => void) | null = null
  /** Brano della riserva o della diretta autonoma in corso: si scrive quando finisce. */
  private current: { entry: ServerPlay; started: number } | null = null

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
    this.write(entry)
    this.onAdd?.(entry)
    return entry
  }

  /**
   * Brano della riserva o della diretta autonoma appena iniziato. Finisce il precedente; la voce si scrive
   * quando finisce (end), con i secondi suonati davvero e non la durata intera del brano.
   */
  begin(p: Omit<ServerPlay, 'at' | 'added' | 'composer' | 'publisher'>): ServerPlay {
    this.end()
    const entry: ServerPlay = { at: new Date(this.now()).toISOString(), source: p.source, id: p.id, title: p.title, artist: p.artist, duration: p.duration }
    this.current = { entry, started: this.now() }
    this.onAdd?.(entry)
    return entry
  }

  /**
   * Il brano in corso è finito: è iniziato il successivo o la sua sorgente non è più in onda. Con `sources`
   * si chiude solo se è di una di quelle. Sotto MIN_PLAYED_SECONDS non si scrive. Restituisce la voce scritta.
   */
  end(sources?: PlaySource[]): ServerPlay | null {
    const c = this.current
    if (!c || (sources && !sources.includes(c.entry.source))) return null
    this.current = null
    let played = (this.now() - c.started) / 1000
    // eventi persi (per esempio la libreria vuota dopo il brano): non oltre la durata del brano
    if (c.entry.duration > 0) played = Math.min(played, c.entry.duration)
    if (played < MIN_PLAYED_SECONDS) return null
    const now = new Date(this.now()).toISOString()
    const entry: ServerPlay = { ...c.entry, ...(now !== c.entry.at ? { added: now } : {}), duration: Math.round(played * 10) / 10 }
    this.write(entry)
    return entry
  }

  private write(entry: ServerPlay): void {
    try {
      if (this.now() - this.lastPrune > PRUNE_EVERY_MS) this.prune()
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
    } catch (e) {
      // disco pieno o simili: si perde la voce ma non si ferma chi suona (eventi, riconoscimento)
      console.error(`[registro] voce non salvata: ${e instanceof Error ? e.message : String(e)}`)
    }
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
