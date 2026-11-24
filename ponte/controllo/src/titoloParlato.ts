/**
 * "Titolo parlato": il titolo che va in onda quando non suona nessun brano (si parla).
 *
 * Scelte di cristian (24/11/2026):
 * - titolo = nome del programma in palinsesto, artista = conduttore (campo "autore" del programma),
 *   immagine = copertina del programma; senza programma in palinsesto nome e slogan della radio;
 * - un testo libero scritto al momento dalla regia o dal pannello (es. "Ospite: Mario Rossi") si aggiunge al
 *   nome del programma; vale fino alla fine del programma in cui è stato scritto;
 * - in regia scatta dopo 5 secondi senza brani (lo decide la regia e lo dice al ponte);
 * - nelle dirette esterne vale il titolo mandato dall'app (BUTT, Larix…), se lo manda; altrimenti il titolo
 *   parlato, tranne mentre suona un brano riconosciuto;
 * - non va mai nel registro dei brani (report SIAE).
 */

export interface SpokenProgram {
  id: string
  title: string
  author: string
}

export interface SpokenSong {
  artist: string
  title: string
}

/** Secondi dopo il collegamento di un'esterna senza titolo dall'app prima di mandare il titolo parlato. */
export const ESTERNA_ATTESA_MS = 5000

/** Lunghezza massima del testo libero. */
export const TESTO_MAX = 120

/** Titolo parlato per il programma in corso (o per la radio, se non c'è un programma). */
export function spokenTitle(i: { program: SpokenProgram | null; text: string; radioName: string; slogan: string }): SpokenSong {
  const text = i.text.trim()
  const radio = i.radioName.trim()
  if (i.program) {
    const name = i.program.title.trim()
    return { artist: i.program.author.trim() || radio, title: text ? `${name} – ${text}` : name }
  }
  const title = text || i.slogan.trim() || radio
  return { artist: title === radio ? '' : radio, title }
}

/** Testo libero: vale solo per il programma in cui è stato scritto (null = fuori programma). */
export class SpokenText {
  private text = ''
  private programId: string | null = null

  set(text: string, programId: string | null): void {
    this.text = text.replace(/\s+/g, ' ').trim().slice(0, TESTO_MAX)
    this.programId = programId
  }

  /** Testo da usare con il programma in corso ('' se è stato scritto in un altro programma). */
  get(programId: string | null): string {
    if (this.programId !== programId) this.text = ''
    return this.text
  }
}

export type SpokenTarget = 'studio' | 'esterna'

export interface SpokenDeps {
  /** Titolo parlato di adesso. */
  compute: () => SpokenSong
  /** Lo manda a Icecast (tramite Liquidsoap) sulla sorgente indicata. */
  send: (target: SpokenTarget, s: SpokenSong) => Promise<boolean>
  /** Lo mostra nel titolo in onda per le app e il player (senza ripetere quello già mostrato). */
  show: (s: SpokenSong) => void
}

export interface SpokenContext {
  now: number
  /** Diretta autonoma in onda. */
  autonoma: boolean
  /** Regia collegata al ponte. */
  studio: boolean
  /** Fine del brano riconosciuto in onda in un'esterna (0 = nessuno). */
  recognizedUntil: number
}

/** Decide quando mandare il titolo parlato, da regia ed esterne. */
export class SpokenTitles {
  /** La regia ha detto che non suona nessun brano. */
  private regia = false
  private esterna: { since: number; appTitle: boolean } | null = null
  private sent: Record<SpokenTarget, string> = { studio: '', esterna: '' }
  private deps: SpokenDeps

  constructor(deps: SpokenDeps) {
    this.deps = deps
  }

  /** Dalla regia: true = nessun brano da 5 secondi, false = è partito un brano (con il suo titolo). */
  setRegia(on: boolean): void {
    this.regia = on
    // la regia ha mandato un titolo suo: il prossimo titolo parlato va rimandato
    if (!on) this.sent.studio = ''
  }

  regiaParlato(): boolean {
    return this.regia
  }

  /** La regia si è ricollegata: il titolo parlato si rimanda. */
  studioConnected(): void {
    this.sent.studio = ''
  }

  esternaConnected(now: number): void {
    this.esterna = { since: now, appTitle: false }
    this.sent.esterna = ''
  }

  esternaDisconnected(): void {
    this.esterna = null
  }

  /** L'app dell'esterna ha mandato un titolo suo: da qui in poi vale quello. */
  esternaAppTitle(): void {
    if (this.esterna) this.esterna.appTitle = true
  }

  /** Cosa va in onda adesso: 'esterna' / 'studio' se si manda il titolo parlato, null se no. */
  target(c: SpokenContext): SpokenTarget | null {
    if (this.esterna) {
      if (this.esterna.appTitle || c.now - this.esterna.since < ESTERNA_ATTESA_MS || c.now < c.recognizedUntil) return null
      return 'esterna'
    }
    if (c.autonoma || !c.studio || !this.regia) return null
    return 'studio'
  }

  /** Da chiamare a ogni cambiamento e ogni pochi secondi (cambio di programma, testo libero, brano riconosciuto finito). */
  async tick(c: SpokenContext): Promise<void> {
    const target = this.target(c)
    if (!target) return
    const s = this.deps.compute()
    if (!s.title && !s.artist) return
    this.deps.show(s)
    const key = `${s.artist}\n${s.title}`
    if (this.sent[target] === key) return
    this.sent[target] = key
    // non arrivato a Liquidsoap: si riprova al prossimo giro
    if (!(await this.deps.send(target, s).catch(() => false))) this.sent[target] = ''
  }
}

/** Titolo mandato dall'app di un'esterna (metadati Icecast): "song" è "Artista - Titolo". */
export function appTitle(m: { artist?: string; title?: string; song?: string }): SpokenSong | null {
  let artist = String(m.artist ?? '').trim()
  let title = String(m.title ?? '').trim()
  const song = String(m.song ?? '').trim()
  if (!title && song) {
    const i = song.indexOf(' - ')
    if (i > 0) {
      artist ||= song.slice(0, i).trim()
      title = song.slice(i + 3).trim()
    } else title = song
  }
  if (!title && !artist) return null
  return { artist: artist.slice(0, 300), title: title.slice(0, 300) }
}
