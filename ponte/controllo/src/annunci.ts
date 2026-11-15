/**
 * Annunci con la voce sintetica: voci disponibili, impostazioni e testo con le parti che si riempiono da sole.
 * Solo dati e testo (niente file né programmi), così lo usa anche l'interfaccia della regia.
 * La voce vera la produce sintesi.ts.
 */

export interface VoiceInfo {
  id: string
  name: string
  description: string
  /** MB circa da scaricare. */
  sizeMb: number
}

export const VOICES: VoiceInfo[] = [
  { id: 'it_IT-paola-medium', name: 'Paola', description: 'donna', sizeMb: 65 },
  { id: 'it_IT-riccardo-x_low', name: 'Riccardo', description: 'uomo (qualità più bassa)', sizeMb: 30 }
]

const MODELS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'

/** Archivio da scaricare per una voce. */
export function voiceUrl(id: string): string {
  if (!VOICES.some((v) => v.id === id)) throw new Error('voce sconosciuta')
  return `${MODELS}/vits-piper-${id}.tar.bz2`
}

export interface VoiceSettings {
  voice: string
  /** 1 = normale, 1,2 = più veloce, 0,8 = più lenta. */
  speed: number
  /** Quanto varia l'intonazione: 0 = piatta, 1 = molto mossa (normale 0,667). */
  expressiveness: number
  /** Quanto varia la durata delle sillabe (normale 0,8). */
  rhythm: number
  /** Pausa tra una frase e l'altra, in secondi. */
  sentencePause: number
  /** Tono in semitoni: negativo = più grave, positivo = più acuto. */
  pitch: number
  /** Volume in dB rispetto al normale. */
  volumeDb: number
}

export const DEFAULT_VOICE: VoiceSettings = {
  voice: 'it_IT-paola-medium',
  speed: 1,
  expressiveness: 0.667,
  rhythm: 0.8,
  sentencePause: 0.4,
  pitch: 0,
  volumeDb: 0
}

const clamp = (v: unknown, min: number, max: number, def: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

/** Impostazioni ripulite (valori fuori misura riportati nei limiti). */
export function cleanVoice(v: Partial<VoiceSettings> | undefined): VoiceSettings {
  const d = DEFAULT_VOICE
  return {
    voice: VOICES.some((x) => x.id === v?.voice) ? v!.voice! : d.voice,
    speed: clamp(v?.speed, 0.5, 2, d.speed),
    expressiveness: clamp(v?.expressiveness, 0, 1, d.expressiveness),
    rhythm: clamp(v?.rhythm, 0, 1.5, d.rhythm),
    sentencePause: clamp(v?.sentencePause, 0, 3, d.sentencePause),
    pitch: clamp(v?.pitch, -6, 6, d.pitch),
    volumeDb: clamp(v?.volumeDb, -12, 12, d.volumeDb)
  }
}

// ---------- testo con le parti che si riempiono da sole ----------

export interface AnnounceContext {
  now: Date
  radio?: string
  /** Brano appena passato (o in onda). */
  track?: { title: string; artist: string } | null
  nextTrack?: { title: string; artist: string } | null
  program?: string | null
  nextProgram?: { title: string; at: Date } | null
}

/** Le parti disponibili, con la spiegazione per l'interfaccia. */
export const PLACEHOLDERS: { key: string; help: string }[] = [
  { key: 'ora', help: 'ora attuale, es. "22 e 50" o "22 in punto"' },
  { key: 'data', help: 'giorno, es. "domenica 15 novembre"' },
  { key: 'radio', help: 'nome della radio' },
  { key: 'brano', help: 'titolo del brano appena passato' },
  { key: 'artista', help: 'artista del brano appena passato' },
  { key: 'prossimo_brano', help: 'titolo del prossimo brano' },
  { key: 'prossimo_artista', help: 'artista del prossimo brano' },
  { key: 'programma', help: 'programma in onda adesso' },
  { key: 'prossimo_programma', help: 'prossimo programma' },
  { key: 'ora_prossimo_programma', help: 'ora del prossimo programma, es. "23 in punto"' }
]

/** Ora detta a voce: "22 e 50", "22 in punto", "mezzanotte", "mezzogiorno". */
export function spokenTime(d: Date): string {
  const h = d.getHours()
  const m = d.getMinutes()
  if (h === 0 && m === 0) return 'mezzanotte'
  if (h === 12 && m === 0) return 'mezzogiorno'
  if (h === 0) return `mezzanotte e ${m}`
  return m === 0 ? `${h} in punto` : `${h} e ${m}`
}

export function spokenDate(d: Date): string {
  return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })
}

/** Riempie le parti tra graffe. Restituisce anche quelle rimaste vuote (per avvisare). */
export function fillTemplate(text: string, ctx: AnnounceContext): { text: string; missing: string[] } {
  const values: Record<string, string | undefined> = {
    ora: spokenTime(ctx.now),
    data: spokenDate(ctx.now),
    radio: ctx.radio?.trim() || undefined,
    brano: ctx.track?.title?.trim() || undefined,
    artista: ctx.track?.artist?.trim() || undefined,
    prossimo_brano: ctx.nextTrack?.title?.trim() || undefined,
    prossimo_artista: ctx.nextTrack?.artist?.trim() || undefined,
    programma: ctx.program?.trim() || undefined,
    prossimo_programma: ctx.nextProgram?.title?.trim() || undefined,
    ora_prossimo_programma: ctx.nextProgram ? spokenTime(ctx.nextProgram.at) : undefined
  }
  const missing: string[] = []
  const out = text.replace(/\{([a-z_]+)\}/g, (all, key: string) => {
    if (!(key in values)) return all
    const v = values[key]
    if (v === undefined) {
      missing.push(key)
      return ''
    }
    return v
  })
  return { text: out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim(), missing }
}

/** Divide il testo in frasi (per mettere la pausa scelta tra una e l'altra). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s))
}

const mins = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))

/** Programma in onda adesso e prossimo, dalle fasce del palinsesto. */
export function programContext(
  programs: { title: string; slots?: { days: number[]; start: string; end: string }[] }[],
  now: Date
): { program: string | null; nextProgram: { title: string; at: Date } | null } {
  let program: string | null = null
  let next: { title: string; at: Date } | null = null
  for (const p of programs) {
    for (const s of p.slots ?? []) {
      // da ieri (fasce che passano la mezzanotte) a fra 7 giorni
      for (let d = -1; d <= 7; d++) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d)
        if (!s.days.includes(day.getDay())) continue
        const from = new Date(day.getTime() + mins(s.start) * 60_000)
        let len = mins(s.end) - mins(s.start)
        if (len <= 0) len += 24 * 60
        const to = new Date(from.getTime() + len * 60_000)
        if (from <= now && now < to) program ??= p.title
        if (from > now && (!next || from < next.at)) next = { title: p.title, at: from }
      }
    }
  }
  return { program, nextProgram: next }
}
