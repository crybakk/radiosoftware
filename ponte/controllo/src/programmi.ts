/**
 * Programmi della radio e puntate da ascoltare on demand (scelte di cristian, 15/11/2026):
 *   - i programmi (nome, conduttori, fasce orarie, copertina) li crea un amministratore dal pannello;
 *   - ogni puntata si registra da sola dalla messa in onda, nella fascia del programma;
 *   - la registrazione resta una bozza: dal pannello si scelgono inizio e fine, titolo e descrizione,
 *     poi si pubblica;
 *   - nessuna scadenza; solo ascolto in streaming (pagina e app), niente feed per Spotify o Apple;
 *   - le API pubbliche sono le stesse di AzuraCast, così l'app della radio continua a funzionare.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Slot {
  /** Giorni della settimana, 0 = domenica … 6 = sabato. */
  days: number[]
  /** "HH:MM" */
  start: string
  /** "HH:MM"; se è prima dell'inizio la fascia finisce il giorno dopo. */
  end: string
}

export interface Program {
  id: string
  title: string
  description: string
  /** Conduttori. */
  author: string
  slots: Slot[]
  /** Registrazione automatica delle fasce. */
  record: boolean
  /** Visibile sulla pagina e nell'app. */
  published: boolean
  /** Copertina presente (file programmi/<id>.jpg|png). */
  art: '' | 'jpg' | 'png'
  artUpdatedAt: number
  createdAt: number
}

export interface Episode {
  id: string
  programId: string
  title: string
  description: string
  /** "bozza" = registrazione da rivedere; "pubblicata" = ascoltabile; "ritirata" = tolta dal pubblico. */
  status: 'registrazione' | 'bozza' | 'pubblicata' | 'ritirata'
  /** Inizio e fine della registrazione (ms). */
  recordedFrom: number
  recordedTo: number
  /** Secondi (della bozza o della puntata pubblicata). */
  length: number
  size: number
  createdAt: number
  publishAt: number
}

export interface ProgramSettings {
  /** Nome breve della stazione negli indirizzi delle API (come su AzuraCast). */
  station: string
  /** Minuti registrati prima e dopo la fascia, per non perdere l'inizio o la fine. */
  marginMinutes: number
}

interface Data {
  settings: ProgramSettings
  programs: Program[]
  episodes: Episode[]
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/
const minutes = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))

export function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'programma'
  )
}

/** Fascia in corso a quell'ora (con i minuti di margine): inizio e fine in ms, oppure null. */
export function activeSlot(slots: Slot[], now: Date, marginMin = 0): { from: number; to: number } | null {
  const margin = marginMin * 60_000
  // si guarda anche ieri, per le fasce che passano la mezzanotte
  for (const back of [0, 1]) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    for (const s of slots) {
      if (!s.days.includes(day.getDay())) continue
      const a = minutes(s.start)
      let b = minutes(s.end)
      if (b <= a) b += 24 * 60
      const from = day.getTime() + a * 60_000 - margin
      const to = day.getTime() + b * 60_000 + margin
      if (now.getTime() >= from && now.getTime() < to) return { from, to }
    }
  }
  return null
}

export function validateProgram(p: Partial<Program>): void {
  if (!p.title?.trim()) throw new Error('scrivi il nome del programma')
  for (const s of p.slots ?? []) {
    if (!HM.test(s.start) || !HM.test(s.end)) throw new Error('orari delle fasce non validi (HH:MM)')
    if (!s.days.length) throw new Error('scegli almeno un giorno per ogni fascia')
    if (s.start === s.end) throw new Error('una fascia deve durare almeno un minuto')
  }
}

/** Archivio dei programmi e delle puntate (un file JSON più le cartelle dell'audio). */
export class Programs {
  readonly dir: string
  private readonly file: string
  private data: Data
  private readonly now: () => number

  constructor(dir: string, now: () => number = () => Date.now()) {
    this.dir = dir
    this.now = now
    this.file = join(dir, 'programmi.json')
    for (const d of ['registrazioni', 'puntate', 'copertine']) mkdirSync(join(dir, d), { recursive: true })
    this.data = { settings: { station: 'radio', marginMinutes: 2 }, programs: [], episodes: [] }
    if (existsSync(this.file)) {
      try {
        const d = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Data>
        this.data = {
          settings: { ...this.data.settings, ...d.settings },
          programs: d.programs ?? [],
          episodes: d.episodes ?? []
        }
      } catch {
        // file rovinato: si riparte vuoti ma non lo si sovrascrive finché non si salva qualcosa
      }
    }
    // registrazioni rimaste a metà (spegnimento): diventano bozze
    for (const e of this.data.episodes) {
      if (e.status === 'registrazione') {
        e.status = 'bozza'
        e.size = this.fileSize(this.rawFile(e.id))
      }
    }
  }

  private save(): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 1))
    renameSync(`${this.file}.tmp`, this.file)
  }

  private fileSize(f: string): number {
    try {
      return statSync(f).size
    } catch {
      return 0
    }
  }

  settings(): ProgramSettings {
    return { ...this.data.settings }
  }

  setSettings(s: Partial<ProgramSettings>): ProgramSettings {
    if (s.station !== undefined) {
      const st = s.station.trim().toLowerCase()
      if (!/^[a-z0-9_-]{1,40}$/.test(st)) throw new Error('nome della stazione: solo lettere minuscole, numeri, "-" e "_"')
      this.data.settings.station = st
    }
    if (s.marginMinutes !== undefined) this.data.settings.marginMinutes = Math.max(0, Math.min(15, Math.round(Number(s.marginMinutes) || 0)))
    this.save()
    return this.settings()
  }

  // ---------- programmi ----------

  list(): Program[] {
    return this.data.programs.map((p) => ({ ...p }))
  }

  get(id: string): Program | undefined {
    return this.data.programs.find((p) => p.id === id)
  }

  saveProgram(input: Partial<Program> & { id?: string }): Program {
    validateProgram(input)
    const slots = (input.slots ?? []).map((s) => ({ days: [...new Set(s.days.filter((d) => d >= 0 && d <= 6))].sort(), start: s.start, end: s.end }))
    const existing = input.id ? this.get(input.id) : undefined
    if (existing) {
      Object.assign(existing, {
        title: input.title!.trim().slice(0, 200),
        description: (input.description ?? '').trim().slice(0, 4000),
        author: (input.author ?? '').trim().slice(0, 300),
        slots,
        record: input.record !== false,
        published: input.published !== false
      })
      this.save()
      return { ...existing }
    }
    let id = slug(input.title!)
    for (let n = 2; this.get(id); n++) id = `${slug(input.title!)}_${n}`
    const p: Program = {
      id,
      title: input.title!.trim().slice(0, 200),
      description: (input.description ?? '').trim().slice(0, 4000),
      author: (input.author ?? '').trim().slice(0, 300),
      slots,
      record: input.record !== false,
      published: input.published !== false,
      art: '',
      artUpdatedAt: 0,
      createdAt: this.now()
    }
    this.data.programs.push(p)
    this.save()
    return { ...p }
  }

  /** Toglie il programma con tutte le sue puntate. */
  removeProgram(id: string): void {
    const p = this.get(id)
    if (!p) throw new Error('programma non trovato')
    for (const e of this.data.episodes.filter((x) => x.programId === id)) this.removeEpisode(e.id)
    if (p.art) rmSync(this.artFile(p), { force: true })
    this.data.programs = this.data.programs.filter((x) => x.id !== id)
    this.save()
  }

  artFile(p: Program): string {
    return join(this.dir, 'copertine', `${p.id}.${p.art || 'jpg'}`)
  }

  setArt(id: string, data: Uint8Array): Program {
    const p = this.get(id)
    if (!p) throw new Error('programma non trovato')
    const png = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    const jpg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    if (!png && !jpg) throw new Error('la copertina deve essere un\'immagine PNG o JPG')
    if (p.art) rmSync(this.artFile(p), { force: true })
    p.art = png ? 'png' : 'jpg'
    p.artUpdatedAt = Math.floor(this.now() / 1000)
    writeFileSync(this.artFile(p), data)
    this.save()
    return { ...p }
  }

  // ---------- puntate ----------

  rawFile(id: string): string {
    return join(this.dir, 'registrazioni', `${id}.mp3`)
  }

  episodeFile(id: string): string {
    return join(this.dir, 'puntate', `${id}.mp3`)
  }

  episodes(programId?: string): Episode[] {
    return this.data.episodes
      .filter((e) => !programId || e.programId === programId)
      .sort((a, b) => b.recordedFrom - a.recordedFrom)
      .map((e) => ({ ...e }))
  }

  episode(id: string): Episode | undefined {
    return this.data.episodes.find((e) => e.id === id)
  }

  /** Nuova registrazione in corso. */
  startRecording(programId: string, from: number): Episode {
    const p = this.get(programId)
    if (!p) throw new Error('programma non trovato')
    const d = new Date(from)
    const e: Episode = {
      id: randomUUID(),
      programId,
      title: `${p.title} del ${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}`,
      description: '',
      status: 'registrazione',
      recordedFrom: from,
      recordedTo: from,
      length: 0,
      size: 0,
      createdAt: this.now(),
      publishAt: 0
    }
    this.data.episodes.push(e)
    this.save()
    return { ...e }
  }

  /** Fine registrazione: diventa una bozza da rivedere (o sparisce se non c'è audio). */
  endRecording(id: string, to: number, length: number): Episode | null {
    const e = this.episode(id)
    if (!e) return null
    const size = this.fileSize(this.rawFile(id))
    if (size < 10_000) {
      rmSync(this.rawFile(id), { force: true })
      this.data.episodes = this.data.episodes.filter((x) => x.id !== id)
      this.save()
      return null
    }
    Object.assign(e, { status: 'bozza', recordedTo: to, length, size })
    this.save()
    return { ...e }
  }

  /** Dopo il taglio: puntata pubblicata. */
  published(id: string, meta: { title: string; description: string; length: number }): Episode {
    const e = this.episode(id)
    if (!e) throw new Error('puntata non trovata')
    Object.assign(e, {
      status: 'pubblicata',
      title: meta.title.trim().slice(0, 300) || e.title,
      description: meta.description.trim().slice(0, 4000),
      length: meta.length,
      size: this.fileSize(this.episodeFile(id)),
      publishAt: e.publishAt || Math.floor(this.now() / 1000)
    })
    rmSync(this.rawFile(id), { force: true })
    this.save()
    return { ...e }
  }

  /** Solo titolo e descrizione (puntata già pubblicata). */
  editEpisode(id: string, meta: { title?: string; description?: string }): Episode {
    const e = this.episode(id)
    if (!e) throw new Error('puntata non trovata')
    if (meta.title?.trim()) e.title = meta.title.trim().slice(0, 300)
    if (meta.description !== undefined) e.description = meta.description.trim().slice(0, 4000)
    this.save()
    return { ...e }
  }

  /** Ritira una puntata pubblicata (non si vede più, il file resta) o la rimette in pubblico. */
  setVisible(id: string, visible: boolean): Episode {
    const e = this.episode(id)
    if (!e || (e.status !== 'pubblicata' && e.status !== 'ritirata')) throw new Error('puntata non trovata')
    e.status = visible ? 'pubblicata' : 'ritirata'
    this.save()
    return { ...e }
  }

  removeEpisode(id: string): void {
    rmSync(this.rawFile(id), { force: true })
    rmSync(this.episodeFile(id), { force: true })
    this.data.episodes = this.data.episodes.filter((x) => x.id !== id)
    this.save()
  }

  /** Puntate visibili al pubblico, dalla più recente. */
  publicEpisodes(programId: string): Episode[] {
    return this.episodes(programId).filter((e) => e.status === 'pubblicata' && existsSync(this.episodeFile(e.id)))
  }

  publicPrograms(): Program[] {
    return this.list().filter((p) => p.published)
  }
}

// ---------- formato delle API pubbliche di AzuraCast ----------

function mmss(s: number): string {
  const t = Math.round(s)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function short(s: string): string {
  return s.length > 100 ? `${s.slice(0, 100)}...` : s
}

/** Api_Podcast di AzuraCast (solo i campi che hanno senso qui; gli altri con valori neutri). */
export function apiPodcast(p: Program, episodes: number, base: string, station: string, stationName: string): Record<string, unknown> {
  const root = `${base}/api/station/${station}/public/podcast/${p.id}`
  return {
    id: p.id,
    storage_location_id: 0,
    source: 'manual',
    playlist_id: null,
    playlist_auto_publish: false,
    title: p.title,
    link: null,
    description: p.description,
    description_short: short(p.description),
    explicit: false,
    is_enabled: true,
    branding_config: { public_custom_html: null, enable_op3_prefix: false },
    language: 'it',
    language_name: 'Italian',
    author: p.author || stationName,
    email: '',
    has_custom_art: p.art !== '',
    art: `${root}/art${p.artUpdatedAt ? `-${p.artUpdatedAt}.jpg` : ''}`,
    art_updated_at: p.artUpdatedAt,
    guid: p.id,
    is_published: p.published,
    episodes,
    categories: [],
    links: {
      self: root,
      episodes: `${root}/episodes`,
      public_episodes: `${base}/podcast.html#${p.id}`,
      public_feed: ''
    }
  }
}

/** Api_PodcastEpisode di AzuraCast. */
export function apiEpisode(e: Episode, p: Program, base: string, station: string): Record<string, unknown> {
  const root = `${base}/api/station/${station}/public/podcast/${p.id}/episode/${e.id}`
  return {
    id: e.id,
    title: e.title,
    link: null,
    description: e.description,
    description_short: short(e.description),
    explicit: false,
    season_number: null,
    episode_number: null,
    created_at: Math.floor(e.createdAt / 1000),
    publish_at: e.publishAt,
    is_published: true,
    has_media: true,
    playlist_media_id: null,
    playlist_media: null,
    media: { id: e.id, original_name: `${e.id}.mp3`, length: e.length, length_text: mmss(e.length), path: `${e.id}.mp3`, size: e.size },
    has_custom_art: false,
    // la puntata usa la copertina del programma
    art: `${base}/api/station/${station}/public/podcast/${p.id}/art${p.artUpdatedAt ? `-${p.artUpdatedAt}.jpg` : ''}`,
    art_updated_at: 0,
    links: {
      self: root,
      public: `${base}/podcast.html#${p.id}/${e.id}`,
      download: `${root}/download.mp3`
    }
  }
}
