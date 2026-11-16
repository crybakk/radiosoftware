/**
 * Report SIAE trimestrale (licenza "radio personale").
 *
 * Scelte di cristian (15/11/2026):
 *   - un report a trimestre, CSV con ";" da caricare sul portale SIAE;
 *   - colonne del fac simile senza "PREZZO DI VENDITA";
 *   - più autori separati da virgola;
 *   - solo musica (niente jingle, spot, notiziari), da tutte le fonti: regia, diretta autonoma,
 *     musica di riserva del server e, quando ci saranno, le esterne riconosciute.
 *
 * Una riga per opera e interprete, con il numero di passaggi nel trimestre.
 * Dove la regia e la riserva (o la diretta autonoma) del server si sovrappongono conta solo il server.
 */
import { csvField } from './csv'
import type { LogEntry, Track } from './types'

export const SIAE_COLUMNS = [
  'TITOLO OPERA',
  'AUTORE',
  'EDITORE',
  'INTERPRETE',
  'UTILIZZAZIONI',
  'CODICE OPERA',
  'CODICE ISWC',
  'CODICE ISRC'
] as const

/** Un passaggio della regia sotto questa durata non conta (brano saltato o sfumato subito). */
export const MIN_PLAYED_SECONDS = 30

/** Fonti del registro che non sono opere musicali (flussi esterni mandati da un evento). */
const NOT_A_WORK = new Set(['flusso esterno'])

export interface SiaeRow {
  title: string
  authors: string
  publisher: string
  performer: string
  uses: number
  siaeCode: string
  iswc: string
  isrc: string
  /** Brano della libreria, se si sa quale (per completarlo dalla scheda). */
  trackId: number | null
}

/** Inizio e fine (esclusa) del trimestre, in ora locale. q = 1..4 */
export function quarterRange(year: number, q: number): [Date, Date] {
  if (!(q >= 1 && q <= 4)) throw new Error('trimestre non valido')
  return [new Date(year, (q - 1) * 3, 1), new Date(year, q * 3, 1)]
}

/** Trimestre che contiene la data. */
export function quarterOf(d: Date): { year: number; q: number } {
  return { year: d.getFullYear(), q: Math.floor(d.getMonth() / 3) + 1 }
}

/** Autori in un'unica forma: "Rossi, Bianchi" (dai tag arrivano anche con "/" o ";"). */
export function normalizeAuthors(s: string): string {
  return s
    .split(/\s*[;/]\s*|\s*,\s*/)
    .map((a) => a.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .filter((a, i, all) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i)
    .join(', ')
}

const key = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Il passaggio va nel report? */
export function counts(e: LogEntry): boolean {
  if (e.kind !== 'music' || NOT_A_WORK.has(e.source)) return false
  // passaggio della regia chiuso: conta solo se è andato in onda abbastanza
  if (e.endedAt && e.source === 'regia' && e.playedSeconds < MIN_PLAYED_SECONDS) return false
  return true
}

/** Fonti del server in cui gli ascoltatori sentivano il server e non la regia (4G caduto, regia spenta). */
const SERVER_ON_AIR = new Set(['riserva', 'autonoma'])
/** Fonti dei passaggi importati dal server (tutte le altre sono della regia). */
const SERVER_SOURCES = new Set(['riserva', 'autonoma', 'esterna'])

/** Inizio e fine (ms) di un passaggio; senza fine si usa la durata suonata. */
function span(e: LogEntry): [number, number] | null {
  const a = Date.parse(e.startedAt)
  if (Number.isNaN(a)) return null
  const end = e.endedAt ? Date.parse(e.endedAt) : NaN
  const b = Number.isNaN(end) ? a + Math.max(0, e.playedSeconds) * 1000 : end
  return [a, Math.max(b, a + 1)]
}

/**
 * Toglie i passaggi della regia che si sovrappongono a quelli della musica di riserva o della diretta autonoma
 * del server: in quei periodi gli ascoltatori sentivano il server, e contarli tutti e due li conterebbe due volte.
 * I passaggi delle esterne restano come sono.
 */
export function dropOverlapped(entries: LogEntry[]): LogEntry[] {
  const server = entries
    .filter((e) => SERVER_ON_AIR.has(e.source))
    .map(span)
    .filter((s): s is [number, number] => s !== null)
    .sort((x, y) => x[0] - y[0])
  if (!server.length) return entries
  // intervalli uniti, per cercare con una ricerca binaria
  const merged: [number, number][] = []
  for (const [a, b] of server) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  const overlaps = (a: number, b: number): boolean => {
    // ultimo intervallo che inizia prima della fine del passaggio
    let lo = 0
    let hi = merged.length - 1
    let i = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (merged[mid][0] < b) {
        i = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return i >= 0 && merged[i][1] > a
  }
  return entries.filter((e) => {
    if (SERVER_SOURCES.has(e.source)) return true
    const s = span(e)
    return !s || !overlaps(s[0], s[1])
  })
}

/**
 * Raggruppa i passaggi per opera e interprete.
 * Per i brani della libreria si usano i dati attuali della scheda (così le correzioni fatte dopo valgono).
 */
export function siaeRows(entries: LogEntry[], tracks: Map<number, Track>): SiaeRow[] {
  const rows = new Map<string, SiaeRow>()
  for (const e of dropOverlapped(entries)) {
    if (!counts(e)) continue
    const t = e.trackId != null ? tracks.get(e.trackId) : undefined
    if (t && t.kind !== 'music') continue
    const d = {
      title: (t?.title || e.title).trim(),
      authors: normalizeAuthors(t?.composer || e.composer),
      publisher: (t?.publisher || e.publisher).trim(),
      performer: (t?.artist || e.artist).trim(),
      siaeCode: (t?.siaeCode || e.siaeCode).trim(),
      iswc: (t?.iswc || e.iswc).trim(),
      isrc: (t?.isrc || e.isrc).trim().toUpperCase()
    }
    if (!d.title) continue
    const k = `${key(d.title)}|${key(d.performer)}`
    const r = rows.get(k)
    if (!r) {
      rows.set(k, { ...d, uses: 1, trackId: t ? t.id : null })
      continue
    }
    r.uses++
    // dati che mancavano in un passaggio e ci sono in un altro
    for (const f of ['authors', 'publisher', 'siaeCode', 'iswc', 'isrc'] as const) if (!r[f] && d[f]) r[f] = d[f]
    if (r.trackId == null && t) r.trackId = t.id
  }
  return [...rows.values()].sort(
    (a, b) => b.uses - a.uses || a.performer.localeCompare(b.performer, 'it') || a.title.localeCompare(b.title, 'it')
  )
}

/** Cosa manca a una riga del report (vuoto = completa). */
export function missingFields(r: Pick<SiaeRow, 'authors' | 'publisher' | 'siaeCode' | 'iswc' | 'isrc'>): string[] {
  const out: string[] = []
  if (!r.authors) out.push('autori')
  if (!r.publisher) out.push('editore')
  if (!r.siaeCode && !r.iswc && !r.isrc) out.push('codice (opera, ISWC o ISRC)')
  return out
}

/** CSV nel tracciato del fac simile (senza PREZZO DI VENDITA), UTF-8 come il modello. */
export function siaeCsv(rows: SiaeRow[]): string {
  const lines = rows.map((r) =>
    [r.title, r.authors, r.publisher, r.performer, r.uses, r.siaeCode, r.iswc, r.isrc].map(csvField).join(';')
  )
  return [SIAE_COLUMNS.join(';'), ...lines].join('\n') + '\n'
}
