/**
 * Rotazioni generate dall'AI: il palinsesto scritto a parole diventa un piano di fasce orarie
 * (generi, anni, separazione artista, jingle), che dopo l'anteprima e l'approvazione diventa una serie
 * di eventi "Regole di rotazione".
 *
 * L'AI (modello locale nella regia) sceglie solo tra i generi presenti nella libreria: lo schema JSON che
 * vincola la risposta li elenca uno per uno, e qui il piano viene comunque ricontrollato.
 * Questo file non usa moduli di Node: si può importare anche dall'interfaccia.
 */
import type { RotationProfile, ScheduledEvent, Track } from './types'

export interface AiSlot {
  /** Nome breve della fascia (es. "Mattina pop"). */
  name: string
  /** 0 = domenica … 6 = sabato. */
  days: number[]
  /** "HH:MM". */
  start: string
  /** "HH:MM": se è prima dell'inizio la fascia passa la mezzanotte. */
  end: string
  genres: string[]
  yearFrom: number | null
  yearTo: number | null
  artistSeparationMinutes: number | null
  jingleEvery: number | null
}

export interface AiPlan {
  slots: AiSlot[]
}

export interface LibrarySummary {
  /** Generi della musica attiva (file e MusicBrainz, in minuscolo), dal più frequente. */
  genres: { name: string; count: number }[]
  yearMin: number | null
  yearMax: number | null
  music: number
}

/** Prefisso dei nomi degli eventi creati dall'AI (per riconoscerli e sostituirli). */
export const AI_LABEL = 'AI · '
/** Generi passati all'AI: oltre si perde precisione e il modello piccolo si confonde. */
const MAX_PROMPT_GENRES = 150
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const DAY_NAMES = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato']

/** Generi del brano: quello del file (anche più di uno, separati) e quelli di MusicBrainz. */
export function trackGenres(t: Pick<Track, 'genre' | 'mbGenres'>): string[] {
  const out: string[] = []
  for (const g of `${t.genre},${t.mbGenres}`.split(/[,;/]/)) {
    const n = g.trim().toLowerCase()
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

export function summarize(tracks: Track[]): LibrarySummary {
  const counts = new Map<string, number>()
  let yearMin: number | null = null
  let yearMax: number | null = null
  for (const t of tracks) {
    for (const g of trackGenres(t)) counts.set(g, (counts.get(g) ?? 0) + 1)
    if (t.year != null) {
      yearMin = yearMin == null ? t.year : Math.min(yearMin, t.year)
      yearMax = yearMax == null ? t.year : Math.max(yearMax, t.year)
    }
  }
  const genres = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'it'))
  return { genres, yearMin, yearMax, music: tracks.length }
}

/** Generi offerti all'AI (i più frequenti). */
export function promptGenres(s: LibrarySummary): string[] {
  return s.genres.slice(0, MAX_PROMPT_GENRES).map((g) => g.name)
}

/** Orari offerti all'AI: ogni 5 minuti (le fasce di una radio non partono a minuti strani). */
const TIMES = Array.from({ length: 288 }, (_, i) => `${String(Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}`)

/**
 * Schema JSON della risposta: vincola il modello a generi, giorni e orari validi.
 * Usa solo le parti di JSON Schema che la grammatica di node-llama-cpp capisce (type, enum, properties,
 * items, minItems, maxItems, maxLength); i limiti dei numeri li rimette a posto cleanPlan().
 */
export function planSchema(genres: string[]): object {
  const optInt = { type: ['integer', 'null'] }
  return {
    type: 'object',
    properties: {
      slots: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 40 },
            days: { type: 'array', minItems: 1, maxItems: 7, items: { enum: [0, 1, 2, 3, 4, 5, 6] } },
            start: { enum: TIMES },
            end: { enum: TIMES },
            genres: genres.length ? { type: 'array', maxItems: 12, items: { enum: genres } } : { type: 'array', maxItems: 0 },
            yearFrom: optInt,
            yearTo: optInt,
            artistSeparationMinutes: optInt,
            jingleEvery: optInt
          }
        }
      }
    }
  }
}

/** Istruzioni per il modello e richiesta dell'utente. */
export function buildPrompt(description: string, s: LibrarySummary): { system: string; user: string } {
  const genres = s.genres.slice(0, MAX_PROMPT_GENRES).map((g) => `${g.name} (${g.count})`).join(', ')
  const years = s.yearMin != null ? `dal ${s.yearMin} al ${s.yearMax}` : 'sconosciuti'
  const system = [
    'Sei l\'assistente di programmazione musicale di una piccola radio italiana.',
    'Trasformi il palinsesto descritto dall\'utente in fasce orarie con regole di rotazione musicale.',
    'Rispondi solo con il JSON richiesto.',
    '',
    'Regole:',
    `- giorni: 0=${DAY_NAMES[0]}, 1=${DAY_NAMES[1]}, 2=${DAY_NAMES[2]}, 3=${DAY_NAMES[3]}, 4=${DAY_NAMES[4]}, 5=${DAY_NAMES[5]}, 6=${DAY_NAMES[6]}. "Tutti i giorni" = 0..6; "feriali" = 1..5; "weekend" = 0 e 6.`,
    '- orari "HH:MM" a 24 ore; "end" è l\'ora in cui la fascia finisce; se "end" è prima di "start" la fascia passa la mezzanotte.',
    '- genres: SOLO generi presi dall\'elenco della libreria, scritti esattamente così; scegli quelli che corrispondono alla descrizione (anche simili: "musica tranquilla" → generi lenti o acustici). Lista vuota = tutta la musica.',
    '- yearFrom / yearTo: solo se la descrizione parla di anni o decenni ("anni 80" = 1980-1989), altrimenti null.',
    '- artistSeparationMinutes e jingleEvery: solo se la descrizione li chiede, altrimenti null.',
    '- non inventare fasce che la descrizione non chiede; le fasce dello stesso giorno non si sovrappongono.',
    '- name: nome breve e chiaro della fascia, in italiano.',
    '',
    `Generi della libreria con il numero di brani: ${genres || 'nessuno'}.`,
    `Anni dei brani: ${years}. Brani di musica: ${s.music}.`
  ].join('\n')
  return { system, user: `Palinsesto:\n${description.trim()}` }
}

function minutes(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
}

/** Intervalli [inizio, fine) in minuti della settimana (0 = domenica 00:00). */
function weekRanges(s: AiSlot): [number, number][] {
  const out: [number, number][] = []
  const a = minutes(s.start)
  let b = minutes(s.end)
  if (b <= a) b += 1440
  for (const d of s.days) out.push([d * 1440 + a, d * 1440 + b])
  return out
}

function overlaps(x: AiSlot, y: AiSlot): boolean {
  const W = 7 * 1440
  for (const [a, b] of weekRanges(x)) {
    for (const [c, d] of weekRanges(y)) {
      for (const shift of [-W, 0, W]) if (a < d + shift && c + shift < b) return true
    }
  }
  return false
}

const intOrNull = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null
}

/**
 * Legge e ricontrolla il piano (dall'AI o modificato a mano): toglie i generi che non sono nella libreria,
 * scarta le fasce senza giorni o con orari sbagliati e segnala le sovrapposizioni.
 */
export function cleanPlan(input: unknown, s: LibrarySummary): { plan: AiPlan; warnings: string[] } {
  const warnings: string[] = []
  const known = new Map(s.genres.map((g) => [g.name.toLowerCase(), g.name]))
  const raw = (input as { slots?: unknown })?.slots
  const slots: AiSlot[] = []
  for (const [i, x] of (Array.isArray(raw) ? raw : []).slice(0, 30).entries()) {
    const o = (x ?? {}) as Record<string, unknown>
    const name = String(o.name ?? '').trim().slice(0, 40) || `Fascia ${i + 1}`
    const start = String(o.start ?? '').trim()
    const end = String(o.end ?? '').trim()
    if (!TIME.test(start) || !TIME.test(end)) {
      warnings.push(`"${name}": orario non valido, tolta`)
      continue
    }
    if (start === end) {
      warnings.push(`"${name}": inizio e fine uguali, tolta`)
      continue
    }
    const days = [...new Set((Array.isArray(o.days) ? o.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    if (!days.length) {
      warnings.push(`"${name}": nessun giorno, tolta`)
      continue
    }
    const genres: string[] = []
    for (const g of Array.isArray(o.genres) ? o.genres : []) {
      const k = known.get(String(g).trim().toLowerCase())
      if (k && !genres.includes(k)) genres.push(k)
      else if (!k && String(g).trim()) warnings.push(`"${name}": il genere "${String(g).trim()}" non è nella libreria, tolto`)
    }
    let yearFrom = intOrNull(o.yearFrom, 1900, 2100)
    let yearTo = intOrNull(o.yearTo, 1900, 2100)
    if (yearFrom != null && yearTo != null && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom]
    slots.push({
      name,
      days,
      start,
      end,
      genres,
      yearFrom,
      yearTo,
      artistSeparationMinutes: intOrNull(o.artistSeparationMinutes, 0, 600),
      jingleEvery: intOrNull(o.jingleEvery, 0, 20)
    })
  }
  slots.sort((a, b) => a.start.localeCompare(b.start) || a.days[0] - b.days[0])
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      if (overlaps(slots[i], slots[j])) warnings.push(`"${slots[i].name}" e "${slots[j].name}" si sovrappongono: vince quella che parte dopo`)
    }
  }
  if (!slots.length) warnings.push('nessuna fascia valida: prova a descrivere il palinsesto con giorni e orari')
  return { plan: { slots }, warnings }
}

/** Il profilo di rotazione della fascia. */
export function slotProfile(s: AiSlot): RotationProfile {
  return {
    name: s.name,
    genres: s.genres,
    yearFrom: s.yearFrom,
    yearTo: s.yearTo,
    artistSeparationMinutes: s.artistSeparationMinutes,
    jingleEvery: s.jingleEvery
  }
}

/** Brani di musica che rispettano la fascia (senza il ripiego su tutta la musica). */
export function matchCount(s: AiSlot, tracks: Track[]): number {
  const want = s.genres.map((g) => g.toLowerCase())
  let n = 0
  for (const t of tracks) {
    if (want.length) {
      const g = `${t.genre}, ${t.mbGenres}`.toLowerCase()
      if (!want.some((x) => g.includes(x))) continue
    }
    if (s.yearFrom != null && (t.year == null || t.year < s.yearFrom)) continue
    if (s.yearTo != null && (t.year == null || t.year > s.yearTo)) continue
    n++
  }
  return n
}

type NewEvent = Omit<ScheduledEvent, 'id'>

const baseEvent = (label: string, time: string, days: number[], profile: RotationProfile | null): NewEvent => ({
  label,
  time,
  days,
  repeatMinutes: 0,
  untilTime: null,
  validFrom: null,
  validTo: null,
  mode: 'soft',
  toleranceSeconds: 0,
  actions: [{ type: 'rotation', profile }],
  enabled: true
})

/**
 * Gli eventi del piano: all'inizio di ogni fascia le sue regole; alla fine, se non parte subito un'altra fascia,
 * si torna alle regole normali (tutta la musica).
 */
export function planEvents(plan: AiPlan): NewEvent[] {
  const out: NewEvent[] = []
  const startsAt = new Set<string>()
  for (const s of plan.slots) for (const d of s.days) startsAt.add(`${d} ${s.start}`)
  for (const s of plan.slots) {
    out.push(baseEvent(`${AI_LABEL}${s.name}`, s.start, s.days, slotProfile(s)))
    const nextDay = minutes(s.end) <= minutes(s.start)
    const endDays = s.days.map((d) => (nextDay ? (d + 1) % 7 : d)).filter((d) => !startsAt.has(`${d} ${s.end}`))
    if (endDays.length) out.push(baseEvent(`${AI_LABEL}fine ${s.name}`, s.end, [...new Set(endDays)].sort(), null))
  }
  return out
}

/** Giorni in parole per l'anteprima ("lun-ven", "tutti i giorni"). */
export function daysLabel(days: number[]): string {
  const k = [...days].sort().join(',')
  if (k === '0,1,2,3,4,5,6') return 'tutti i giorni'
  if (k === '1,2,3,4,5') return 'dal lunedì al venerdì'
  if (k === '0,6') return 'sabato e domenica'
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => DAY_NAMES[d]).join(', ')
}
