import { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_PONTE,
  DEFAULT_SETTINGS,
  type EventAction,
  type LibraryFolder,
  type LogEntry,
  type ScheduledEvent,
  type Settings,
  type Track,
  type TrackKind
} from './types'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'music'
);

CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'music',
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  year INTEGER,
  genre TEXT NOT NULL DEFAULT '',
  composer TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  isrc TEXT NOT NULL DEFAULT '',
  iswc TEXT NOT NULL DEFAULT '',
  siae_code TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  bitrate INTEGER NOT NULL DEFAULT 0,
  sample_rate INTEGER NOT NULL DEFAULT 0,
  loudness REAL,
  cue_in REAL NOT NULL DEFAULT 0,
  cue_out REAL NOT NULL DEFAULT 0,
  mix_point REAL NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  file_size INTEGER NOT NULL DEFAULT 0,
  file_mtime REAL NOT NULL DEFAULT 0,
  analyzed_at TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tracks_kind ON tracks(kind, enabled);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  time TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'soft',
  enabled INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
  repeat_minutes INTEGER NOT NULL DEFAULT 0,
  until_time TEXT,
  valid_from TEXT,
  valid_to TEXT,
  mode TEXT NOT NULL DEFAULT 'soft',
  tolerance_seconds INTEGER NOT NULL DEFAULT 0,
  actions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS play_log (
  id INTEGER PRIMARY KEY,
  track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  played_seconds REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'regia',
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  composer TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  isrc TEXT NOT NULL DEFAULT '',
  iswc TEXT NOT NULL DEFAULT '',
  siae_code TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'music'
);
CREATE INDEX IF NOT EXISTS play_log_started ON play_log(started_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

type Row = Record<string, unknown>

function rowToTrack(r: Row): Track {
  return {
    id: Number(r.id),
    path: String(r.path),
    kind: r.kind as TrackKind,
    title: String(r.title),
    artist: String(r.artist),
    album: String(r.album),
    year: r.year == null ? null : Number(r.year),
    genre: String(r.genre),
    composer: String(r.composer),
    publisher: String(r.publisher),
    isrc: String(r.isrc),
    iswc: String(r.iswc),
    siaeCode: String(r.siae_code),
    duration: Number(r.duration),
    bitrate: Number(r.bitrate),
    sampleRate: Number(r.sample_rate),
    loudness: r.loudness == null ? null : Number(r.loudness),
    cueIn: Number(r.cue_in),
    cueOut: Number(r.cue_out),
    mixPoint: Number(r.mix_point),
    enabled: Number(r.enabled) === 1,
    analyzedAt: r.analyzed_at == null ? null : String(r.analyzed_at),
    addedAt: String(r.added_at)
  }
}

function rowToLog(r: Row): LogEntry {
  return {
    id: Number(r.id),
    trackId: r.track_id == null ? null : Number(r.track_id),
    startedAt: String(r.started_at),
    endedAt: r.ended_at == null ? null : String(r.ended_at),
    playedSeconds: Number(r.played_seconds),
    source: String(r.source),
    title: String(r.title),
    artist: String(r.artist),
    composer: String(r.composer),
    publisher: String(r.publisher),
    isrc: String(r.isrc),
    iswc: String(r.iswc),
    siaeCode: String(r.siae_code),
    kind: r.kind as TrackKind
  }
}

export interface ScannedFile {
  path: string
  kind: TrackKind
  size: number
  mtime: number
  title: string
  artist: string
  album: string
  year: number | null
  genre: string
  composer: string
  publisher: string
  isrc: string
  duration: number
  bitrate: number
  sampleRate: number
}

export interface AnalysisResult {
  duration: number
  loudness: number | null
  cueIn: number
  cueOut: number
  mixPoint: number
}

export interface TrackSearch {
  text?: string
  kind?: TrackKind
  limit?: number
  offset?: number
}

/** Campi che l'utente può correggere a mano dalla scheda brano. */
export type TrackEdit = Partial<
  Pick<
    Track,
    | 'title'
    | 'artist'
    | 'album'
    | 'year'
    | 'genre'
    | 'composer'
    | 'publisher'
    | 'isrc'
    | 'iswc'
    | 'siaeCode'
    | 'kind'
    | 'enabled'
    | 'cueIn'
    | 'cueOut'
    | 'mixPoint'
  >
>

const EDIT_COLUMNS: Record<keyof TrackEdit, string> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  year: 'year',
  genre: 'genre',
  composer: 'composer',
  publisher: 'publisher',
  isrc: 'isrc',
  iswc: 'iswc',
  siaeCode: 'siae_code',
  kind: 'kind',
  enabled: 'enabled',
  cueIn: 'cue_in',
  cueOut: 'cue_out',
  mixPoint: 'mix_point'
}

export class RadioDb {
  readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** Porta i dati delle versioni precedenti al formato attuale. */
  private migrate(): void {
    // v0.4: scelta a mano dei brani da tenere sulla libreria del server (null = decide la regola)
    const cols = (this.db.prepare('PRAGMA table_info(tracks)').all() as Row[]).map((r) => String(r.name))
    if (!cols.includes('server_choice')) this.db.exec('ALTER TABLE tracks ADD COLUMN server_choice INTEGER')
    // v0.1: eventi con un solo brano (tabella "events") → eventi con azioni (tabella "schedule")
    const old = this.db.prepare('SELECT * FROM events').all() as Row[]
    if (old.length) {
      const ins = this.db.prepare(
        'INSERT INTO schedule(label, time, days, mode, actions, enabled) VALUES (?,?,?,?,?,?)'
      )
      for (const r of old) {
        ins.run(
          String(r.label),
          String(r.time),
          String(r.days),
          String(r.mode),
          JSON.stringify([{ type: 'play', trackId: Number(r.track_id) }]),
          Number(r.enabled)
        )
      }
      this.db.exec('DELETE FROM events')
    }
  }

  close(): void {
    this.db.close()
  }

  // ---------- impostazioni ----------

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Row[]
    const out: Settings = structuredClone(DEFAULT_SETTINGS)
    for (const r of rows) {
      const key = String(r.key) as keyof Settings
      if (!(key in out)) continue
      try {
        ;(out as unknown as Record<string, unknown>)[key] = JSON.parse(String(r.value))
      } catch {
        // valore corrotto: resta il predefinito
      }
    }
    if (!Array.isArray(out.cartwall) || out.cartwall.length !== 12) {
      const cw = Array(12).fill(null)
      if (Array.isArray(out.cartwall)) out.cartwall.slice(0, 12).forEach((v, i) => (cw[i] = v))
      out.cartwall = cw
    }
    // campi aggiunti nelle versioni successive: completati con i predefiniti
    out.ponte = { ...DEFAULT_PONTE, ...(out.ponte && typeof out.ponte === 'object' ? out.ponte : {}) }
    return out
  }

  /** Copia coerente del database in un file nuovo (anche mentre la regia è in onda). */
  backupTo(path: string): void {
    this.db.prepare('VACUUM INTO ?').run(path)
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS) || v === undefined) continue
      stmt.run(k, JSON.stringify(v))
    }
    return this.getSettings()
  }

  // ---------- cartelle ----------

  listFolders(): LibraryFolder[] {
    return (this.db.prepare('SELECT id, path, kind FROM folders ORDER BY path').all() as Row[]).map((r) => ({
      id: Number(r.id),
      path: String(r.path),
      kind: r.kind as TrackKind
    }))
  }

  addFolder(path: string, kind: TrackKind): void {
    this.db
      .prepare('INSERT INTO folders(path, kind) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET kind = excluded.kind')
      .run(path, kind)
  }

  removeFolder(id: number): void {
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
  }

  // ---------- brani ----------

  /** Stato del file già in libreria, per saltare i file non modificati. */
  fileState(path: string): { size: number; mtime: number } | null {
    const r = this.db.prepare('SELECT file_size, file_mtime FROM tracks WHERE path = ?').get(path) as Row | undefined
    return r ? { size: Number(r.file_size), mtime: Number(r.file_mtime) } : null
  }

  /** Inserisce o aggiorna un file scansionato. Se il file è cambiato, l'analisi va rifatta. */
  upsertScanned(f: ScannedFile): number {
    const existing = this.db.prepare('SELECT id FROM tracks WHERE path = ?').get(f.path) as Row | undefined
    if (existing) {
      this.db
        .prepare(
          `UPDATE tracks SET kind=?, title=?, artist=?, album=?, year=?, genre=?,
             composer=CASE WHEN composer='' THEN ? ELSE composer END,
             publisher=CASE WHEN publisher='' THEN ? ELSE publisher END,
             isrc=CASE WHEN isrc='' THEN ? ELSE isrc END,
             duration=?, bitrate=?, sample_rate=?, file_size=?, file_mtime=?, analyzed_at=NULL
           WHERE id=?`
        )
        .run(
          f.kind,
          f.title,
          f.artist,
          f.album,
          f.year,
          f.genre,
          f.composer,
          f.publisher,
          f.isrc,
          f.duration,
          f.bitrate,
          f.sampleRate,
          f.size,
          f.mtime,
          Number(existing.id)
        )
      return Number(existing.id)
    }
    const res = this.db
      .prepare(
        `INSERT INTO tracks(path, kind, title, artist, album, year, genre, composer, publisher, isrc,
           duration, bitrate, sample_rate, cue_in, cue_out, mix_point, file_size, file_mtime)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`
      )
      .run(
        f.path,
        f.kind,
        f.title,
        f.artist,
        f.album,
        f.year,
        f.genre,
        f.composer,
        f.publisher,
        f.isrc,
        f.duration,
        f.bitrate,
        f.sampleRate,
        f.duration,
        f.duration,
        f.size,
        f.mtime
      )
    return Number(res.lastInsertRowid)
  }

  /** Segna come disabilitati i brani i cui file non esistono più. */
  disableMissing(existingPaths: Set<string>, folderPrefixes: string[]): number {
    const rows = this.db.prepare('SELECT id, path FROM tracks WHERE enabled = 1').all() as Row[]
    const stmt = this.db.prepare('UPDATE tracks SET enabled = 0 WHERE id = ?')
    let n = 0
    for (const r of rows) {
      const p = String(r.path)
      if (!folderPrefixes.some((pre) => p.startsWith(pre))) continue
      if (!existingPaths.has(p)) {
        stmt.run(Number(r.id))
        n++
      }
    }
    return n
  }

  saveAnalysis(id: number, a: AnalysisResult): void {
    this.db
      .prepare(
        `UPDATE tracks SET duration=?, loudness=?, cue_in=?, cue_out=?, mix_point=?, analyzed_at=datetime('now') WHERE id=?`
      )
      .run(a.duration, a.loudness, a.cueIn, a.cueOut, a.mixPoint, id)
  }

  pendingAnalysis(limit = 50): Track[] {
    return (
      this.db
        .prepare('SELECT * FROM tracks WHERE analyzed_at IS NULL AND enabled = 1 ORDER BY id LIMIT ?')
        .all(limit) as Row[]
    ).map(rowToTrack)
  }

  countPendingAnalysis(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE analyzed_at IS NULL AND enabled = 1').get() as Row
    return Number(r.n)
  }

  getTrack(id: number): Track | null {
    const r = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Row | undefined
    return r ? rowToTrack(r) : null
  }

  getTracks(ids: number[]): Track[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return (this.db.prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`).all(...ids) as Row[]).map(
      rowToTrack
    )
  }

  updateTrack(id: number, edit: TrackEdit): Track | null {
    const sets: string[] = []
    const values: (string | number | null)[] = []
    for (const [k, v] of Object.entries(edit) as [keyof TrackEdit, unknown][]) {
      const col = EDIT_COLUMNS[k]
      if (!col || v === undefined) continue
      sets.push(`${col} = ?`)
      values.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null))
    }
    if (sets.length) this.db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    return this.getTrack(id)
  }

  searchTracks(q: TrackSearch): { tracks: Track[]; total: number } {
    const where: string[] = ['enabled = 1']
    const params: (string | number)[] = []
    if (q.kind) {
      where.push('kind = ?')
      params.push(q.kind)
    }
    const words = (q.text ?? '').trim().split(/\s+/).filter(Boolean)
    for (const w of words) {
      where.push("(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\')")
      const like = `%${w.replace(/[\\%_]/g, (c) => '\\' + c)}%`
      params.push(like, like, like)
    }
    const clause = where.join(' AND ')
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${clause}`).get(...params) as Row).n
    )
    const tracks = (
      this.db
        .prepare(`SELECT * FROM tracks WHERE ${clause} ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE LIMIT ? OFFSET ?`)
        .all(...params, q.limit ?? 200, q.offset ?? 0) as Row[]
    ).map(rowToTrack)
    return { tracks, total }
  }

  /** Musica della libreria con dimensione del file e scelta a mano per il server. */
  musicForServer(): { track: Track; size: number; choice: boolean | null }[] {
    return (this.db.prepare("SELECT * FROM tracks WHERE kind = 'music'").all() as Row[]).map((r) => ({
      track: rowToTrack(r),
      size: Number(r.file_size),
      choice: r.server_choice == null ? null : Number(r.server_choice) === 1
    }))
  }

  setServerChoice(id: number, choice: boolean | null): void {
    this.db.prepare('UPDATE tracks SET server_choice = ? WHERE id = ?').run(choice === null ? null : choice ? 1 : 0, id)
  }

  /** Brani candidati per la rotazione automatica. */
  rotationCandidates(kind: TrackKind): Track[] {
    return (this.db.prepare('SELECT * FROM tracks WHERE kind = ? AND enabled = 1').all(kind) as Row[]).map(rowToTrack)
  }

  libraryStats(): { total: number; byKind: Record<string, number>; pendingAnalysis: number } {
    const rows = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM tracks WHERE enabled = 1 GROUP BY kind')
      .all() as Row[]
    const byKind: Record<string, number> = {}
    let total = 0
    for (const r of rows) {
      byKind[String(r.kind)] = Number(r.n)
      total += Number(r.n)
    }
    return { total, byKind, pendingAnalysis: this.countPendingAnalysis() }
  }

  // ---------- eventi ----------

  listEvents(): ScheduledEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM schedule ORDER BY CASE WHEN time LIKE '*%' THEN 0 ELSE 1 END, time")
      .all() as Row[]
    return rows.map((r) => {
      let actions: EventAction[] = []
      try {
        actions = JSON.parse(String(r.actions))
      } catch {
        actions = []
      }
      return {
        id: Number(r.id),
        label: String(r.label),
        time: String(r.time),
        days: String(r.days)
          .split(',')
          .filter((d) => d !== '')
          .map(Number),
        repeatMinutes: Number(r.repeat_minutes),
        untilTime: r.until_time == null ? null : String(r.until_time),
        validFrom: r.valid_from == null ? null : String(r.valid_from),
        validTo: r.valid_to == null ? null : String(r.valid_to),
        mode: r.mode === 'hard' ? 'hard' : 'soft',
        toleranceSeconds: Number(r.tolerance_seconds),
        actions,
        enabled: Number(r.enabled) === 1
      }
    })
  }

  saveEvent(e: Omit<ScheduledEvent, 'id'> & { id?: number }): number {
    validateEvent(e)
    const days = e.days.filter((d) => d >= 0 && d <= 6).join(',')
    const values = [
      e.label,
      e.time,
      days,
      Math.max(0, Math.round(e.repeatMinutes || 0)),
      e.untilTime || null,
      e.validFrom || null,
      e.validTo || null,
      e.mode,
      Math.max(0, Math.round(e.toleranceSeconds || 0)),
      JSON.stringify(e.actions),
      e.enabled ? 1 : 0
    ]
    if (e.id) {
      this.db
        .prepare(
          `UPDATE schedule SET label=?, time=?, days=?, repeat_minutes=?, until_time=?, valid_from=?, valid_to=?,
             mode=?, tolerance_seconds=?, actions=?, enabled=? WHERE id=?`
        )
        .run(...values, e.id)
      return e.id
    }
    const res = this.db
      .prepare(
        `INSERT INTO schedule(label, time, days, repeat_minutes, until_time, valid_from, valid_to, mode,
           tolerance_seconds, actions, enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(...values)
    return Number(res.lastInsertRowid)
  }

  deleteEvent(id: number): void {
    this.db.prepare('DELETE FROM schedule WHERE id = ?').run(id)
  }

  /** Brano casuale che rispetta i filtri, evitando quelli andati in onda di recente se possibile. */
  randomTrack(f: { kind?: TrackKind | ''; folder?: string; genre?: string }, avoidSince?: Date): Track | null {
    const where = ['enabled = 1']
    const params: (string | number)[] = []
    if (f.kind) {
      where.push('kind = ?')
      params.push(f.kind)
    }
    if (f.folder) {
      where.push("path LIKE ? ESCAPE '\\'")
      const prefix = f.folder.replace(/[\\/]+$/, '')
      params.push(`${prefix.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
    }
    if (f.genre) {
      where.push("genre LIKE ? ESCAPE '\\'")
      params.push(`%${f.genre.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
    }
    const clause = where.join(' AND ')
    if (avoidSince) {
      const r = this.db
        .prepare(
          `SELECT * FROM tracks WHERE ${clause} AND id NOT IN
             (SELECT track_id FROM play_log WHERE track_id IS NOT NULL AND started_at >= ?)
           ORDER BY random() LIMIT 1`
        )
        .get(...params, avoidSince.toISOString()) as Row | undefined
      if (r) return rowToTrack(r)
    }
    const r = this.db.prepare(`SELECT * FROM tracks WHERE ${clause} ORDER BY random() LIMIT 1`).get(...params) as
      | Row
      | undefined
    return r ? rowToTrack(r) : null
  }

  findByPath(path: string, caseInsensitive = false): Track | null {
    const r = this.db
      .prepare(`SELECT * FROM tracks WHERE path = ? ${caseInsensitive ? 'COLLATE NOCASE' : ''} LIMIT 1`)
      .get(path) as Row | undefined
    return r ? rowToTrack(r) : null
  }

  /** Generi presenti nella libreria (per i menu delle regole di rotazione). */
  listGenres(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT genre FROM tracks WHERE enabled = 1 AND genre != '' ORDER BY genre COLLATE NOCASE")
      .all() as Row[]
    const set = new Set<string>()
    for (const r of rows) for (const g of String(r.genre).split(/[,;/]/)) if (g.trim()) set.add(g.trim())
    return [...set].sort((a, b) => a.localeCompare(b, 'it'))
  }

  // ---------- registro di trasmissione ----------

  logStart(track: Track, startedAt: Date, source = 'regia'): number {
    const res = this.db
      .prepare(
        `INSERT INTO play_log(track_id, started_at, source, title, artist, composer, publisher, isrc, iswc, siae_code, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        track.id > 0 ? track.id : null,
        startedAt.toISOString(),
        source,
        track.title,
        track.artist,
        track.composer,
        track.publisher,
        track.isrc,
        track.iswc,
        track.siaeCode,
        track.kind
      )
    return Number(res.lastInsertRowid)
  }

  logEnd(logId: number, endedAt: Date, playedSeconds: number): void {
    this.db
      .prepare('UPDATE play_log SET ended_at = ?, played_seconds = ? WHERE id = ?')
      .run(endedAt.toISOString(), Math.max(0, playedSeconds), logId)
  }

  /** Voci di registro in un intervallo [from, to). */
  listLog(from: Date, to: Date): LogEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM play_log WHERE started_at >= ? AND started_at < ? ORDER BY started_at')
        .all(from.toISOString(), to.toISOString()) as Row[]
    ).map(rowToLog)
  }

  /** Ultime messe in onda (per le regole di separazione). */
  recentPlays(since: Date): { trackId: number | null; artist: string; startedAt: string }[] {
    return (
      this.db
        .prepare('SELECT track_id, artist, started_at FROM play_log WHERE started_at >= ? ORDER BY started_at DESC')
        .all(since.toISOString()) as Row[]
    ).map((r) => ({
      trackId: r.track_id == null ? null : Number(r.track_id),
      artist: String(r.artist),
      startedAt: String(r.started_at)
    }))
  }

  /** Chiude le voci rimaste aperte (per esempio dopo un crash). */
  closeDanglingLog(now: Date): void {
    this.db
      .prepare(
        `UPDATE play_log SET ended_at = ? WHERE ended_at IS NULL`
      )
      .run(now.toISOString())
  }
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/

/** Controlla un evento prima di salvarlo; gli errori sono in italiano per l'interfaccia. */
export function validateEvent(e: Omit<ScheduledEvent, 'id'>): void {
  if (!/^([01]\d|2[0-3]|\*):[0-5]\d$/.test(e.time)) throw new Error('Orario non valido, usa HH:MM')
  if (e.untilTime && !HM.test(e.untilTime)) throw new Error('Orario di fine ripetizioni non valido')
  if (e.validFrom && e.validTo && e.validFrom > e.validTo) throw new Error('La data di inizio è dopo quella di fine')
  if (!e.days.length) throw new Error('Scegli almeno un giorno')
  if (!e.actions.length) throw new Error("Aggiungi almeno un'azione")
  for (const a of e.actions) {
    if (a.type === 'play' && !a.trackId) throw new Error('Scegli il brano da suonare')
    if (a.type === 'playlist' && !a.path.trim()) throw new Error('Indica il file della playlist')
    if (a.type === 'stream') {
      if (!/^https?:\/\//i.test(a.url.trim())) throw new Error("L'indirizzo del flusso deve iniziare con http:// o https://")
      if (!(a.minutes > 0)) throw new Error('Indica per quanti minuti trasmettere il flusso')
    }
    if (a.type === 'command' && !a.command.trim()) throw new Error('Scrivi il comando da eseguire')
  }
}
