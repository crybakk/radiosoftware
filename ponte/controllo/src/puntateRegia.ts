/**
 * Puntate dei programmi fatti dallo studio (scelte di cristian, 23/11/2026).
 *
 * La regia registra anche lei i programmi segnati "Va in onda dallo studio". A fine registrazione chiede
 * al server cosa fare (POST /api/programmi/regia/fine):
 *   - la regia non si è mai scollegata dal ponte e il ponte ha la sua registrazione → si tiene quella del
 *     ponte (già passata dal processore della diretta), tagliata sui segni di inizio e fine della regia,
 *     e si pubblica subito. Il file della regia non viaggia sul 4G.
 *   - ci sono state interruzioni (o il ponte non ha registrato) → la regia manda il suo file
 *     (PUT /api/programmi/regia/registrazione), che diventa la puntata al posto di quella del ponte, con i
 *     segni nei punti delle interruzioni. Alla pubblicazione passa in Stereo Tool come ultimo passaggio.
 * Se inizio e fine sono stati entrambi automatici (dal palinsesto, nessun segno) la puntata resta da
 * rivedere anche senza interruzioni. Si rivede dal pannello o da Telegram.
 */
import { randomUUID } from 'node:crypto'
import type { CollegamentoStudio, Interruzione } from './collegamentoStudio.ts'
import type { Episode, Marker, Programs } from './programmi.ts'

export interface FineRegia {
  programId: string
  /** Inizio e fine della registrazione della regia (ms). */
  startedAt: number
  endedAt: number
  /** Segni di inizio e fine programma (ms), se messi in regia (o registrazione avviata/fermata a mano). */
  startMark: number | null
  endMark: number | null
  /** Inizio e fine automatici dal palinsesto, senza segni. */
  startAuto: boolean
  endAuto: boolean
}

/** Margine di tolleranza tra gli orologi di regia e server (ms). */
const TOLLERANZA = 5000

export function leggiFine(q: Record<string, unknown>): FineRegia {
  const n = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const startedAt = n(q.startedAt)
  const endedAt = n(q.endedAt)
  if (!q.programId || startedAt === null || endedAt === null || endedAt <= startedAt) throw new Error('dati della registrazione non validi')
  return {
    programId: String(q.programId),
    startedAt,
    endedAt,
    startMark: n(q.startMark),
    endMark: n(q.endMark),
    startAuto: q.startAuto === true || q.startAuto === '1' || q.startAuto === 'true',
    endAuto: q.endAuto === true || q.endAuto === '1' || q.endAuto === 'true'
  }
}

/** Inizio e fine del programma (ms): i segni se ci sono, altrimenti la registrazione intera. */
function taglio(f: FineRegia): { from: number; to: number } {
  const from = f.startMark !== null && f.startMark >= f.startedAt && f.startMark < f.endedAt ? f.startMark : f.startedAt
  const to = f.endMark !== null && f.endMark > from && f.endMark <= f.endedAt ? f.endMark : f.endedAt
  return { from, to }
}

const hms = (s: number): string => {
  const t = Math.max(0, Math.round(s))
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** Segni di inizio, fine e interruzioni, in secondi dall'inizio del file che comincia a `base` (ms). */
export function segni(f: FineRegia, base: number, interr: Interruzione[]): Marker[] {
  const out: Marker[] = []
  const t = taglio(f)
  if (f.startMark !== null || !f.startAuto) out.push({ at: Math.max(0, (t.from - base) / 1000), kind: 'inizio' })
  for (const i of interr) {
    out.push({
      at: Math.max(0, (i.from - base) / 1000),
      kind: 'interruzione',
      length: Math.round((i.to - i.from) / 1000),
      note: i.kind === 'avvio' ? 'il server è ripartito' : 'regia scollegata dal ponte'
    })
  }
  if (f.endMark !== null || !f.endAuto) out.push({ at: Math.max(0, (t.to - base) / 1000), kind: 'fine' })
  return out.sort((a, b) => a.at - b.at)
}

function motivo(interr: Interruzione[], f: FineRegia): string | undefined {
  if (interr.length) return `${interr.length} ${interr.length === 1 ? 'interruzione' : 'interruzioni'} del collegamento: controlla i segni rossi`
  if (f.startAuto && f.endAuto) return 'inizio e fine automatici dal palinsesto: controlla dove iniziare e finire'
  return undefined
}

export interface PuntateRegiaDeps {
  programs: Programs
  studio: CollegamentoStudio
  /** Pubblica una bozza tagliata (secondi). */
  publish: (id: string, meta: { from: number; to: number; title: string; description: string }) => Promise<Episode>
  /** Nuova puntata da rivedere (pannello + Telegram). */
  daRivedere: (e: Episode) => void
  /** Durata del file in secondi. */
  seconds: (file: string) => Promise<number>
  log?: (s: string) => void
}

export class PuntateRegia {
  private readonly d: PuntateRegiaDeps
  private readonly log: (s: string) => void

  constructor(d: PuntateRegiaDeps) {
    this.d = d
    this.log = d.log ?? ((s) => console.log(`[puntate regia] ${s}`))
  }

  /** Registrazione del ponte dello stesso programma che copre il programma. */
  private registrazionePonte(f: FineRegia): Episode | undefined {
    const t = taglio(f)
    return this.d.programs
      .episodes(f.programId)
      .find(
        (e) =>
          e.source !== 'regia' &&
          !e.replaced &&
          (e.status === 'registrazione' || e.status === 'bozza') &&
          e.recordedFrom <= t.from + TOLLERANZA &&
          (e.status === 'registrazione' || e.recordedTo >= t.to - TOLLERANZA)
      )
  }

  /** Fine registrazione in regia: si tiene quella del ponte ("ponte") o serve il file della regia ("regia"). */
  async fine(f: FineRegia): Promise<{ usa: 'ponte' | 'regia'; interruzioni: Interruzione[]; revisione: boolean }> {
    if (!this.d.programs.get(f.programId)) throw new Error('programma non trovato')
    const interr = this.d.studio.interruzioni(f.startedAt, f.endedAt)
    const why = motivo(interr, f)
    const ep = interr.length ? undefined : this.registrazionePonte(f)
    if (!ep) return { usa: 'regia', interruzioni: interr, revisione: !!why }
    const t = taglio(f)
    const cut = { from: Math.max(0, (t.from - ep.recordedFrom) / 1000), to: (t.to - ep.recordedFrom) / 1000 }
    const markers = segni(f, ep.recordedFrom, [])
    if (ep.status === 'registrazione') {
      // si pubblica (o si segnala) appena il ponte chiude la sua registrazione: vedi dopoRegistrazione
      this.d.programs.patchEpisode(ep.id, { markers, cut, reason: why, autoPublish: why ? undefined : t })
    } else {
      const e = this.d.programs.patchEpisode(ep.id, { markers, cut: { ...cut, to: Math.min(cut.to, ep.length || cut.to) }, reason: why })
      if (why) this.d.daRivedere(e)
      else await this.pubblica(e)
    }
    this.log(`${ep.title}: tenuta la registrazione del ponte${why ? ', da rivedere' : ''}`)
    return { usa: 'ponte', interruzioni: [], revisione: !!why }
  }

  private async pubblica(e: Episode): Promise<void> {
    const cut = e.cut ?? { from: 0, to: e.length }
    try {
      await this.d.publish(e.id, { from: cut.from, to: Math.min(cut.to, e.length || cut.to), title: e.title, description: e.description })
      this.log(`pubblicata da sola: ${e.title}`)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      if (this.d.programs.episode(e.id)) {
        const back = this.d.programs.patchEpisode(e.id, { reason: `pubblicazione automatica non riuscita: ${why}` })
        this.d.daRivedere(back)
      }
    }
  }

  /**
   * Il ponte ha chiuso una sua registrazione: se la regia l'ha sostituita si toglie, se la regia ha
   * chiesto di pubblicarla lo si fa adesso. Restituisce true se ci ha pensato lei (niente avviso solito).
   */
  dopoRegistrazione(e: Episode): boolean {
    const cur = this.d.programs.episode(e.id)
    if (!cur) return true
    if (cur.replaced) {
      this.d.programs.removeEpisode(cur.id)
      this.log(`${cur.title}: registrazione del ponte tolta, si usa quella della regia`)
      return true
    }
    if (cur.autoPublish) {
      const from = Math.max(0, (cur.autoPublish.from - cur.recordedFrom) / 1000)
      const to = Math.min(cur.length || Infinity, (cur.autoPublish.to - cur.recordedFrom) / 1000)
      const e2 = this.d.programs.patchEpisode(cur.id, { autoPublish: undefined, cut: { from, to } })
      void this.pubblica(e2)
      return true
    }
    if (cur.markers?.length || cur.reason) {
      this.d.daRivedere(cur)
      return true
    }
    return false
  }

  /** File della regia ricevuto (già salvato in registrazioni/<id>.mp3 con l'id dato da nuovoId()). */
  async ricevuto(id: string, f: FineRegia): Promise<Episode> {
    if (!this.d.programs.get(f.programId)) throw new Error('programma non trovato')
    const interr = this.d.studio.interruzioni(f.startedAt, f.endedAt)
    const why = motivo(interr, f)
    const length = (await this.d.seconds(this.d.programs.rawFile(id)).catch(() => 0)) || Math.round((f.endedAt - f.startedAt) / 1000)
    const t = taglio(f)
    const cut = { from: Math.max(0, (t.from - f.startedAt) / 1000), to: Math.min(length, (t.to - f.startedAt) / 1000) }
    const e = this.d.programs.addStudioEpisode({ id, programId: f.programId, from: f.startedAt, to: f.endedAt, length, markers: segni(f, f.startedAt, interr), cut, reason: why })
    // la registrazione del ponte dello stesso programma non serve più
    for (const old of this.d.programs.episodes(f.programId)) {
      if (old.source === 'regia' || old.id === id) continue
      if (old.recordedFrom > f.endedAt + TOLLERANZA || (old.status !== 'registrazione' && old.recordedTo < f.startedAt - TOLLERANZA)) continue
      if (old.status === 'bozza') this.d.programs.removeEpisode(old.id)
      else if (old.status === 'registrazione') this.d.programs.patchEpisode(old.id, { replaced: true })
    }
    this.log(`ricevuta la registrazione della regia: ${e.title} (${hms(length)})${why ? `, da rivedere: ${why}` : ''}`)
    if (why) this.d.daRivedere(e)
    else await this.pubblica(e)
    return this.d.programs.episode(id) ?? e
  }

  nuovoId(): string {
    return randomUUID()
  }
}
