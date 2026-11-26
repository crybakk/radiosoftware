/**
 * Annunci con la voce sintetica sul server: a orario, solo quando trasmette il server
 * (diretta autonoma o musica di riserva). Quando c'è la regia, gli annunci li fa la regia con i suoi eventi.
 *
 * All'ora dell'annuncio l'annuncio si mette in attesa; va in onda dopo il brano in corso (con la musica
 * di riserva dopo il brano successivo, perché Liquidsoap lo prepara in anticipo). Il testo ({ora}, {brano}, ...)
 * si riempie e la voce si produce solo quando si sa quando andrà in onda: così l'ora detta è quella vera
 * (prima si diceva l'ora in cui scattava l'annuncio, anche 3-4 minuti prima di andare in onda).
 */
import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { cleanVoice, DEFAULT_VOICE, fillTemplate, type AnnounceContext, type VoiceSettings } from './annunci.ts'

export interface ScheduledAnnounce {
  id: string
  text: string
  /** "HH:MM" oppure "*:MM" (ogni ora al minuto MM). */
  time: string
  /** 0 = domenica … 6 = sabato. */
  days: number[]
  enabled: boolean
}

export interface AnnounceConfig {
  voice: VoiceSettings
  /** Nome della radio per {radio} (vuoto = NOME_RADIO del server). */
  radio: string
  items: ScheduledAnnounce[]
}

const TIME = /^(\*|[01]\d|2[0-3]):[0-5]\d$/

export function validateConfig(input: Partial<AnnounceConfig>): AnnounceConfig {
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, 100).map((x, i) => {
    const text = String(x?.text ?? '').trim()
    const time = String(x?.time ?? '').trim()
    if (!text) throw new Error(`annuncio ${i + 1}: manca il testo`)
    if (text.length > 3000) throw new Error(`annuncio ${i + 1}: testo troppo lungo`)
    if (!TIME.test(time)) throw new Error(`annuncio ${i + 1}: orario non valido (HH:MM, oppure "ogni ora" al minuto scelto)`)
    const days = [...new Set((Array.isArray(x?.days) ? x.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    if (!days.length) throw new Error(`annuncio ${i + 1}: scegli almeno un giorno`)
    return { id: String(x?.id ?? '').trim() || `a${Date.now().toString(36)}${i}`, text, time, days, enabled: x?.enabled !== false }
  })
  return { voice: cleanVoice(input.voice), radio: String(input.radio ?? '').trim().slice(0, 100), items }
}

/** Annunci da fare in questo minuto. */
export function dueAt(items: ScheduledAnnounce[], now: Date): ScheduledAnnounce[] {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return items.filter((a) => a.enabled && a.days.includes(now.getDay()) && (a.time === `${hh}:${mm}` || a.time === `*:${mm}`))
}

export class AnnounceStore {
  private readonly file: string
  private cfg: AnnounceConfig = { voice: DEFAULT_VOICE, radio: '', items: [] }

  constructor(file: string) {
    this.file = file
    if (existsSync(file)) {
      try {
        this.cfg = validateConfig(JSON.parse(readFileSync(file, 'utf8')) as Partial<AnnounceConfig>)
      } catch {
        // file rovinato: si riparte dai valori normali
      }
    }
  }

  get(): AnnounceConfig {
    return structuredClone(this.cfg)
  }

  async save(input: Partial<AnnounceConfig>): Promise<AnnounceConfig> {
    this.cfg = validateConfig(input)
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.cfg, null, 1))
    await rename(`${this.file}.tmp`, this.file)
    return this.get()
  }
}

export interface Interjection {
  /** Percorso relativo alla cartella della musica (come gli id della libreria del server). */
  id: string
  title: string
  seconds: number
  expires: number
}

/** Annuncio scattato, in attesa di andare in onda (la voce non è ancora prodotta). */
interface DueAnnounce {
  item: ScheduledAnnounce
  expires: number
}

export interface SchedulerDeps {
  store: AnnounceStore
  speak: (text: string, voice: VoiceSettings) => Promise<{ file: string; seconds: number }>
  /** true se adesso trasmette il server (diretta autonoma o riserva). */
  onAir: () => Promise<boolean>
  context: () => Omit<AnnounceContext, 'now' | 'radio'>
  stationName: string
  /** Sottocartella della musica dove finiscono gli MP3 (es. ".annunci"). */
  folder: string
  now?: () => Date
  log?: (s: string) => void
  /**
   * Secondi di anticipo (scelta di cristian, 17/11/2026): l'annuncio si prepara prima dell'orario, così chi
   * ascolta in HLS (in ritardo sulla diretta) lo sente in orario. Il testo usa l'ora prevista, non quella reale.
   */
  anticipoSecondi?: number
  /** Tempo massimo per produrre la voce quando l'annuncio sta per andare in onda (normale 15 secondi). */
  speakTimeoutMs?: number
}

export class AnnounceScheduler {
  private readonly d: SchedulerDeps
  private readonly now: () => Date
  private readonly log: (s: string) => void
  private lastMinute = ''
  /** Ultima volta che è partito ogni annuncio (per non ripeterlo quando l'ora legale finisce). */
  private fired = new Map<string, string>()
  private pending: DueAnnounce[] = []
  private taking = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(d: SchedulerDeps) {
    this.d = d
    this.now = d.now ?? (() => new Date())
    this.log = d.log ?? ((s) => console.log(`[annunci] ${s}`))
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), 15_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Testo pronto per la voce, con le parti riempite. */
  fill(text: string, radio?: string, at: Date = this.now()): { text: string; missing: string[] } {
    const cfg = this.d.store.get()
    return fillTemplate(text, { now: at, radio: radio?.trim() || cfg.radio || this.d.stationName, ...this.d.context() })
  }

  /** Controlla se in questo minuto c'è un annuncio da fare (una volta sola per minuto). */
  async tick(): Promise<void> {
    // si ragiona sull'orario che sentiranno gli ascoltatori: adesso più l'anticipo
    const now = new Date(this.now().getTime() + Math.max(0, this.d.anticipoSecondi ?? 0) * 1000)
    // minuto vero (non l'ora del giorno): con il ritorno all'ora solare le 2:xx vengono due volte
    const key = String(Math.floor(now.getTime() / 60_000))
    if (key === this.lastMinute) return
    this.lastMinute = key
    const items = this.d.store.get().items
    // "ogni ora" va ogni ora vera; un orario fisso una volta sola al giorno, anche se le 2:30 vengono due volte
    const firedKey = (a: ScheduledAnnounce): string => (a.time.startsWith('*') ? key : `${now.toDateString()} ${a.time}`)
    const due = dueAt(items, now).filter((a) => this.fired.get(a.id) !== firedKey(a))
    for (const a of due) this.fired.set(a.id, firedKey(a))
    for (const id of this.fired.keys()) if (!items.some((a) => a.id === id)) this.fired.delete(id)
    if (!due.length) return
    if (!(await this.d.onAir().catch(() => false))) return
    const expires = this.now().getTime() + 10 * 60_000
    for (const a of due) this.pending.push({ item: a, expires })
  }

  /**
   * Il prossimo annuncio da mandare in onda, se ce n'è uno (quelli troppo vecchi si buttano).
   * airsAt = quando partirà davvero: il testo dice l'ora di quel momento (più l'anticipo per l'HLS,
   * cioè l'ora in cui lo sente chi ascolta in ritardo) e la voce si produce adesso.
   * Se la voce non è pronta in tempo l'annuncio resta in attesa e si riprova al cambio di brano dopo.
   */
  async take(airsAt: Date = this.now()): Promise<Interjection | null> {
    // una voce alla volta: diretta autonoma e riserva insieme non devono mandare in onda lo stesso annuncio
    if (this.taking) return null
    this.taking = true
    try {
      return await this.doTake(airsAt)
    } finally {
      this.taking = false
    }
  }

  private async doTake(airsAt: Date): Promise<Interjection | null> {
    const t = this.now().getTime()
    this.pending = this.pending.filter((p) => p.expires > t)
    while (this.pending.length) {
      const p = this.pending[0]
      const at = new Date(Math.max(t, airsAt.getTime()) + Math.max(0, this.d.anticipoSecondi ?? 0) * 1000)
      const f = this.fill(p.item.text, undefined, at)
      if (!f.text.replace(/[\s.,;:!?]/g, '')) {
        this.pending.shift()
        continue
      }
      const limit = this.d.speakTimeoutMs ?? 15_000
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const r = await Promise.race([
          this.d.speak(f.text, this.d.store.get().voice),
          new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('voce troppo lenta: riprovo al prossimo brano')), limit)))
        ])
        this.pending.shift()
        this.log(`in onda: "${f.text}"${f.missing.length ? ` (senza ${f.missing.join(', ')})` : ''}`)
        return { id: `${this.d.folder}/${basename(r.file)}`, title: f.text, seconds: r.seconds, expires: p.expires }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.log(`annuncio non preparato: ${msg}`)
        // voce lenta (es. si sta scaricando la prima volta): si riprova dopo; un errore vero lo toglie
        if (!msg.startsWith('voce troppo lenta')) this.pending.shift()
        return null
      } finally {
        clearTimeout(timer)
      }
    }
    return null
  }

  /** Annunci pronti in attesa (per il pannello). */
  waiting(): number {
    return this.pending.length
  }
}
