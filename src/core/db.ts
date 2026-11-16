import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
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
  missing INTEGER NOT NULL DEFAULT 0,
  kind_manual INTEGER NOT NULL DEFAULT 0,
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

/** Musica attiva a cui manca un dato che MusicBrainz può dare (autori, editore, ISRC, ISWC). */
const MB_TODO = "kind = 'music' AND enabled = 1 AND (composer = '' OR publisher = '' OR isrc = '' OR iswc = '')"
/** Musica attiva da cercare su MusicBrainz: dati SIAE mancanti mai cercati, oppure generi non ancora letti. */
const MB_PENDING = `kind = 'music' AND enabled = 1 AND ((${MB_TODO} AND mb_checked_at IS NULL) OR mb_genres_at IS NULL)`
/** Musica cercata per titolo senza trovarla e mai provata con AcoustID (dall'audio). */
const MB_ACOUSTID = "kind = 'music' AND enabled = 1 AND mb_checked_at IS NOT NULL AND mb_recording_id = '' AND acoustid_at IS NULL"

export type MbTrack = Track & { recordingId: string; checked: boolean; acoustIdTried: boolean }

function rowToMbTrack(r: Row): MbTrack {
  return {
    ...rowToTrack(r),
    recordingId: String(r.mb_recording_id),
    checked: r.mb_checked_at != null,
    acoustIdTried: r.acoustid_at != null
  }
}

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
    mbGenres: r.mb_genres == null ? '' : String(r.mb_genres),
    dcGenres: r.dc_genres == null ? '' : String(r.dc_genres),
    lfmTags: r.lfm_tags == null ? '' : String(r.lfm_tags),
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

/**
 * Campi corretti a mano dalla scheda brano (colonna manual_fields, una cifra binaria per campo):
 * quando il file cambia sul disco la scansione e la nuova analisi non li sovrascrivono.
 * Autori, editore e ISRC sono già protetti a parte (il file li riempie solo se vuoti).
 */
const MANUAL_BITS = {
  title: 1,
  artist: 2,
  album: 4,
  year: 8,
  genre: 16,
  cueIn: 32,
  cueOut: 64,
  mixPoint: 128
} as const satisfies Partial<Record<keyof TrackEdit, number>>

/** Espressione SQL: il valore della colonna resta com'è se il campo è stato corretto a mano, altrimenti prende `?`. */
function unlessManual(col: string, field: keyof typeof MANUAL_BITS): string {
  return `${col}=CASE WHEN manual_fields & ${MANUAL_BITS[field]} THEN ${col} ELSE ? END`
}

export class RadioDb {
  readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    // minuscolo() di SQLite tocca solo le lettere ASCII: per la ricerca serve anche "À" → "à",
    // e senza accenti ("citta" trova "città" e "CITTÀ")
    this.db.function('minuscolo', { deterministic: true }, (v) => (typeof v === 'string' ? perRicerca(v) : v))
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** Porta i dati delle versioni precedenti al formato attuale. */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(tracks)').all() as Row[]).map((r) => String(r.name))
    // v0.2: "missing" distingue i brani disabilitati dalla scansione (file sparito o non audio) da quelli
    // disabilitati dall'utente; "kind_manual" ricorda che il tipo è stato cambiato a mano.
    // Nei database esistenti i brani già disabilitati restano tali (non si può sapere chi li ha disabilitati).
    if (!cols.includes('missing')) this.db.exec('ALTER TABLE tracks ADD COLUMN missing INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('kind_manual')) this.db.exec('ALTER TABLE tracks ADD COLUMN kind_manual INTEGER NOT NULL DEFAULT 0')
    // v0.4: scelta a mano dei brani da tenere sulla libreria del server (null = decide la regola)
    if (!cols.includes('server_choice')) this.db.exec('ALTER TABLE tracks ADD COLUMN server_choice INTEGER')
    // v0.7: completamento dei dati con MusicBrainz
    if (!cols.includes('mb_recording_id')) this.db.exec("ALTER TABLE tracks ADD COLUMN mb_recording_id TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('mb_checked_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN mb_checked_at TEXT')
    // v0.8: impronta audio per il riconoscimento nelle dirette esterne
    // (in una tabella a parte: le impronte pesano e non servono alle altre letture dei brani)
    // v0.9: generi di MusicBrainz (per le rotazioni), separati da quello scritto nel file
    if (!cols.includes('mb_genres')) this.db.exec("ALTER TABLE tracks ADD COLUMN mb_genres TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('mb_genres_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN mb_genres_at TEXT')
    // v0.10: generi e stili da Discogs, etichette da Last.fm, ricerca dall'audio con AcoustID
    if (!cols.includes('dc_genres')) this.db.exec("ALTER TABLE tracks ADD COLUMN dc_genres TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('dc_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN dc_at TEXT')
    if (!cols.includes('lfm_tags')) this.db.exec("ALTER TABLE tracks ADD COLUMN lfm_tags TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('lfm_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN lfm_at TEXT')
    if (!cols.includes('acoustid_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN acoustid_at TEXT')
    this.db.exec('CREATE TABLE IF NOT EXISTS lfm_artists (name TEXT PRIMARY KEY, tags TEXT NOT NULL, checked_at TEXT NOT NULL)')
    this.db.exec('CREATE TABLE IF NOT EXISTS mb_artists (id TEXT PRIMARY KEY, genres TEXT NOT NULL, checked_at TEXT NOT NULL)')
    // v0.10: campi corretti a mano (titolo, artista, ..., punti di mix); nei database esistenti nessuno è segnato
    if (!cols.includes('manual_fields')) this.db.exec('ALTER TABLE tracks ADD COLUMN manual_fields INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('fp_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN fp_at TEXT')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS fingerprints (track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE, fp BLOB NOT NULL)'
    )
    // v0.7: brani suonati dal server (diretta autonoma, riserva) importati nel registro, una volta sola
    const logCols = (this.db.prepare('PRAGMA table_info(play_log)').all() as Row[]).map((r) => String(r.name))
    if (!logCols.includes('ext_id')) this.db.exec('ALTER TABLE play_log ADD COLUMN ext_id TEXT')
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS play_log_ext ON play_log(ext_id) WHERE ext_id IS NOT NULL')
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
    if (out.playoutMode !== 'auto') out.playoutMode = 'manual'
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

  /** Toglie una cartella dalla libreria e disabilita i suoi brani (non quelli coperti da un'altra cartella). */
  removeFolder(id: number): void {
    const r = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(id) as Row | undefined
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
    if (!r) return
    const dir = trimSep(resolve(String(r.path)))
    const others = this.listFolders().map((f) => resolve(f.path))
    const like = (sep: string): string => `${escapeLike(dir + sep)}%`
    const rows = this.db
      .prepare("SELECT id, path FROM tracks WHERE enabled = 1 AND (path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')")
      .all(like('/'), like('\\')) as Row[]
    const stmt = this.db.prepare('UPDATE tracks SET enabled = 0, missing = 1 WHERE id = ?')
    for (const t of rows) {
      const p = String(t.path)
      // LIKE ignora maiuscole/minuscole: il controllo esatto lo facciamo qui
      if (isUnder(p, dir) && !others.some((o) => isUnder(p, o))) stmt.run(Number(t.id))
    }
  }

  // ---------- brani ----------

  /** Id più alto tra i brani (0 se la libreria è vuota). */
  lastTrackId(): number {
    const r = this.db.prepare('SELECT MAX(id) AS n FROM tracks').get() as Row
    return Number(r.n ?? 0)
  }

  /** Stato del file già in libreria, per saltare i file non modificati. */
  fileState(path: string): { size: number; mtime: number } | null {
    const r = this.db.prepare('SELECT file_size, file_mtime FROM tracks WHERE path = ?').get(path) as Row | undefined
    return r ? { size: Number(r.file_size), mtime: Number(r.file_mtime) } : null
  }

  /**
   * File già in libreria e non modificato: riabilita il brano solo se era stato disabilitato dalla scansione
   * e aggiorna il tipo solo se l'utente non l'ha cambiato a mano.
   */
  refreshUnchanged(path: string, kind: TrackKind): void {
    this.db
      .prepare(
        `UPDATE tracks SET enabled = CASE WHEN missing = 1 THEN 1 ELSE enabled END, missing = 0,
           kind = CASE WHEN kind_manual = 1 THEN kind ELSE ? END
         WHERE path = ?`
      )
      .run(kind, path)
  }

  /** Disabilita un brano in automatico (file sparito, non audio o illeggibile): una nuova scansione lo riabilita. */
  markMissing(id: number): void {
    this.db.prepare('UPDATE tracks SET enabled = 0, missing = 1 WHERE id = ?').run(id)
  }

  /** Inserisce o aggiorna un file scansionato. Se il file è cambiato, l'analisi va rifatta. */
  upsertScanned(f: ScannedFile): number {
    const existing = this.db.prepare('SELECT id FROM tracks WHERE path = ?').get(f.path) as Row | undefined
    if (existing) {
      this.db
        .prepare(
          `UPDATE tracks SET kind=CASE WHEN kind_manual = 1 THEN kind ELSE ? END,
             enabled=CASE WHEN missing = 1 THEN 1 ELSE enabled END, missing=0,
             ${unlessManual('title', 'title')}, ${unlessManual('artist', 'artist')}, ${unlessManual('album', 'album')},
             ${unlessManual('year', 'year')}, ${unlessManual('genre', 'genre')},
             composer=CASE WHEN composer='' THEN ? ELSE composer END,
             publisher=CASE WHEN publisher='' THEN ? ELSE publisher END,
             isrc=CASE WHEN isrc='' THEN ? ELSE isrc END,
             duration=?, bitrate=?, sample_rate=?, file_size=?, file_mtime=?, analyzed_at=NULL, fp_at=NULL
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

  /**
   * Segna come disabilitati i brani i cui file non esistono più.
   * I brani sotto `unreadableDirs` (cartelle che non si sono potute leggere, per esempio un NAS spento) restano come sono,
   * e così quelli con id oltre `maxId` (aggiunti dopo l'inizio della scansione).
   */
  disableMissing(existingPaths: Set<string>, folderPrefixes: string[], unreadableDirs: string[] = [], maxId = Number.MAX_SAFE_INTEGER): number {
    const rows = this.db.prepare('SELECT id, path FROM tracks WHERE enabled = 1 AND id <= ?').all(maxId) as Row[]
    const stmt = this.db.prepare('UPDATE tracks SET enabled = 0, missing = 1 WHERE id = ?')
    let n = 0
    for (const r of rows) {
      const p = String(r.path)
      if (!folderPrefixes.some((pre) => isUnder(p, pre))) continue
      if (unreadableDirs.some((d) => isUnder(p, d))) continue
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
        `UPDATE tracks SET duration=?, loudness=?, ${unlessManual('cue_in', 'cueIn')}, ${unlessManual('cue_out', 'cueOut')},
           ${unlessManual('mix_point', 'mixPoint')}, analyzed_at=datetime('now') WHERE id=?`
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
    const before = this.getTrack(id)
    let manual = 0
    for (const [k, v] of Object.entries(edit) as [keyof TrackEdit, unknown][]) {
      const col = Object.hasOwn(EDIT_COLUMNS, k) ? EDIT_COLUMNS[k] : undefined
      if (!col || v === undefined) continue
      sets.push(`${col} = ?`)
      values.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null))
      // segnato come corretto a mano solo se il valore cambia davvero
      const bit = Object.hasOwn(MANUAL_BITS, k) ? (MANUAL_BITS as Partial<Record<keyof TrackEdit, number>>)[k] : undefined
      if (bit && before && before[k] !== v) manual |= bit
    }
    if (manual) {
      sets.push('manual_fields = manual_fields | ?')
      values.push(manual)
    }
    // abilitato/disabilitato a mano: è una scelta dell'utente, la scansione non la cambia più
    if (edit.enabled !== undefined) sets.push('missing = 0')
    // tipo cambiato a mano: la scansione non lo riporta a quello della cartella
    if (edit.kind !== undefined) {
      sets.push('kind_manual = CASE WHEN kind != ? THEN 1 ELSE kind_manual END')
      values.push(edit.kind)
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
    // al massimo 200 caratteri e 8 parole diverse: una ricerca enorme (anche dal pannello remoto)
    // non deve bloccare la regia per secondi
    const words = [...new Set(String(q.text ?? '').slice(0, 200).trim().split(/\s+/).filter(Boolean))].slice(0, 8)
    for (const w of words) {
      // le parole non contengono spazi, quindi non possono "scavalcare" il separatore tra i campi
      where.push("minuscolo(title || ' ' || artist || ' ' || album) LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(perRicerca(w))}%`)
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
  musicForServer(): { track: Track; size: number; choice: boolean | null; missing: boolean }[] {
    return (this.db.prepare("SELECT * FROM tracks WHERE kind = 'music'").all() as Row[]).map((r) => ({
      track: rowToTrack(r),
      size: Number(r.file_size),
      choice: r.server_choice == null ? null : Number(r.server_choice) === 1,
      // file sparito (disabilitato dalla scansione), diverso dal brano disabilitato a mano
      missing: Number(r.missing) === 1
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

  /**
   * Dopo un ripristino dal server: spegne gli eventi che lanciano un comando esterno, perché un
   * backup arriva da fuori e non deve poter far eseguire programmi sul PC. Si riaccendono a mano.
   * Restituisce i nomi degli eventi spenti.
   */
  disableCommandEvents(): string[] {
    const off = this.listEvents().filter((e) => e.enabled && e.actions.some((a) => a?.type === 'command'))
    const stmt = this.db.prepare('UPDATE schedule SET enabled = 0 WHERE id = ?')
    for (const e of off) stmt.run(e.id)
    return off.map((e) => e.label)
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
      // genere del file o generi di MusicBrainz
      where.push("(genre || ',' || mb_genres || ',' || dc_genres || ',' || lfm_tags) LIKE ? ESCAPE '\\'")
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
      .prepare(
        "SELECT genre AS g FROM tracks WHERE enabled = 1 AND genre != '' UNION SELECT mb_genres FROM tracks WHERE enabled = 1 AND mb_genres != '' " +
          "UNION SELECT dc_genres FROM tracks WHERE enabled = 1 AND dc_genres != '' UNION SELECT lfm_tags FROM tracks WHERE enabled = 1 AND lfm_tags != ''"
      )
      .all() as Row[]
    // senza distinguere maiuscole: "Pop" del file e "pop" di MusicBrainz sono lo stesso genere
    const seen = new Map<string, string>()
    for (const r of rows) {
      for (const g of String(r.g).split(/[,;/]/)) {
        const t = g.trim()
        if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t)
      }
    }
    const set = new Set(seen.values())
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

  /**
   * Passaggio suonato dal server (diretta autonoma, musica di riserva). extId evita i doppioni
   * quando lo stesso periodo viene scaricato più volte. Restituisce true se è nuovo.
   */
  importPlay(p: {
    extId: string
    startedAt: string
    seconds: number
    source: string
    track: Track | null
    title: string
    artist: string
    composer?: string
    publisher?: string
  }): boolean {
    const t = p.track
    const end = new Date(new Date(p.startedAt).getTime() + p.seconds * 1000).toISOString()
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO play_log(ext_id, track_id, started_at, ended_at, played_seconds, source, title, artist,
           composer, publisher, isrc, iswc, siae_code, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        p.extId,
        t ? t.id : null,
        p.startedAt,
        end,
        p.seconds,
        p.source,
        t?.title || p.title,
        t?.artist || p.artist,
        t?.composer || p.composer || '',
        t?.publisher || p.publisher || '',
        t?.isrc ?? '',
        t?.iswc ?? '',
        t?.siaeCode ?? '',
        t?.kind ?? 'music'
      )
    return Number(res.changes) > 0
  }

  /** Inizio dell'ultimo passaggio importato dal server (null = mai). */
  lastServerPlay(): string | null {
    const r = this.db.prepare('SELECT MAX(started_at) AS m FROM play_log WHERE ext_id IS NOT NULL').get() as Row
    return r.m == null ? null : String(r.m)
  }

  // ---------- impronte audio ----------

  /** Musica senza impronta (da calcolare). */
  pendingFingerprint(limit = 20): Track[] {
    return (
      this.db
        .prepare("SELECT * FROM tracks WHERE kind = 'music' AND enabled = 1 AND fp_at IS NULL ORDER BY id LIMIT ?")
        .all(limit) as Row[]
    ).map(rowToTrack)
  }

  fingerprintStats(): { done: number; total: number } {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN fp_at IS NOT NULL THEN 1 ELSE 0 END) AS done FROM tracks WHERE kind = 'music' AND enabled = 1"
      )
      .get() as Row
    return { done: Number(r.done ?? 0), total: Number(r.total ?? 0) }
  }

  /** fp vuoto = file illeggibile (non si riprova finché il file non cambia). */
  saveFingerprint(id: number, fp: Uint8Array | null): void {
    if (fp && fp.length) this.db.prepare('INSERT OR REPLACE INTO fingerprints(track_id, fp) VALUES (?, ?)').run(id, fp)
    else this.db.prepare('DELETE FROM fingerprints WHERE track_id = ?').run(id)
    this.db.prepare("UPDATE tracks SET fp_at = datetime('now') WHERE id = ?").run(id)
  }

  /** Brani di musica con l'impronta (senza leggerla): per decidere cosa mandare al server. */
  fingerprinted(): { track: Track; bytes: number }[] {
    return (
      this.db
        .prepare(
          `SELECT t.*, length(f.fp) AS fp_bytes FROM tracks t JOIN fingerprints f ON f.track_id = t.id
           WHERE t.kind = 'music' AND t.enabled = 1 AND t.fp_at IS NOT NULL`
        )
        .all() as Row[]
    ).map((r) => ({ track: rowToTrack(r), bytes: Number(r.fp_bytes) }))
  }

  getFingerprint(id: number): Uint8Array | null {
    const r = this.db.prepare('SELECT fp FROM fingerprints WHERE track_id = ?').get(id) as Row | undefined
    return r ? (r.fp as Uint8Array) : null
  }

  // ---------- MusicBrainz ----------

  /** Musica a cui manca qualche dato per il report SIAE e non ancora cercata su MusicBrainz. */
  mbPending(limit = 20, acoustId = false): MbTrack[] {
    // con AcoustID tornano in coda anche i brani cercati per titolo senza trovarli e mai provati dall'audio
    const where = acoustId ? `(${MB_PENDING}) OR (${MB_ACOUSTID})` : MB_PENDING
    return (this.db.prepare(`SELECT * FROM tracks WHERE ${where} ORDER BY id LIMIT ?`).all(limit) as Row[]).map(rowToMbTrack)
  }

  /** Un brano con lo stato della ricerca su MusicBrainz (registrazione già trovata, già cercato...). */
  mbTrack(id: number): MbTrack | null {
    const r = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Row | undefined
    return r ? rowToMbTrack(r) : null
  }

  mbStats(acoustId = false): { todo: number; checked: number; found: number } {
    const pending = acoustId ? `(${MB_PENDING}) OR (${MB_ACOUSTID})` : MB_PENDING
    const r = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN ${pending} THEN 1 ELSE 0 END) AS todo,
           SUM(CASE WHEN mb_checked_at IS NOT NULL THEN 1 ELSE 0 END) AS checked,
           SUM(CASE WHEN mb_recording_id != '' THEN 1 ELSE 0 END) AS found
         FROM tracks WHERE kind = 'music' AND enabled = 1`
      )
      .get() as Row
    return { todo: Number(r.todo ?? 0), checked: Number(r.checked ?? 0), found: Number(r.found ?? 0) }
  }

  /** Salva quello che ha trovato MusicBrainz, solo nei campi vuoti: i dati scritti a mano non si toccano. */
  saveMb(
    id: number,
    recordingId: string,
    fill: { composer?: string; publisher?: string; isrc?: string; iswc?: string; genres?: string[]; year?: number | null }
  ): void {
    this.db
      .prepare(
        `UPDATE tracks SET mb_recording_id = ?, mb_checked_at = datetime('now'),
           mb_genres = ?, mb_genres_at = datetime('now'),
           year = CASE WHEN year IS NULL THEN ? ELSE year END,
           composer = CASE WHEN composer = '' THEN ? ELSE composer END,
           publisher = CASE WHEN publisher = '' THEN ? ELSE publisher END,
           isrc = CASE WHEN isrc = '' THEN ? ELSE isrc END,
           iswc = CASE WHEN iswc = '' THEN ? ELSE iswc END
         WHERE id = ?`
      )
      .run(recordingId, (fill.genres ?? []).join(', '), fill.year ?? null, fill.composer ?? '', fill.publisher ?? '', fill.isrc ?? '', fill.iswc ?? '', id)
  }

  // ---------- Discogs, Last.fm, AcoustID ----------

  /** Musica attiva non ancora cercata su Discogs (dc) o Last.fm (lfm). */
  tagPending(service: 'dc' | 'lfm', limit = 20): Track[] {
    const col = service === 'dc' ? 'dc_at' : 'lfm_at'
    return (
      this.db
        .prepare(`SELECT * FROM tracks WHERE kind = 'music' AND enabled = 1 AND ${col} IS NULL ORDER BY id LIMIT ?`)
        .all(limit) as Row[]
    ).map(rowToTrack)
  }

  tagStats(service: 'dc' | 'lfm'): { todo: number; checked: number; found: number } {
    const [at, val] = service === 'dc' ? ['dc_at', 'dc_genres'] : ['lfm_at', 'lfm_tags']
    const r = this.db
      .prepare(
        `SELECT SUM(CASE WHEN ${at} IS NULL THEN 1 ELSE 0 END) AS todo,
                SUM(CASE WHEN ${at} IS NOT NULL THEN 1 ELSE 0 END) AS checked,
                SUM(CASE WHEN ${val} != '' THEN 1 ELSE 0 END) AS found
         FROM tracks WHERE kind = 'music' AND enabled = 1`
      )
      .get() as Row
    return { todo: Number(r.todo ?? 0), checked: Number(r.checked ?? 0), found: Number(r.found ?? 0) }
  }

  saveTags(service: 'dc' | 'lfm', id: number, tags: string[]): void {
    const [at, val] = service === 'dc' ? ['dc_at', 'dc_genres'] : ['lfm_at', 'lfm_tags']
    this.db.prepare(`UPDATE tracks SET ${val} = ?, ${at} = datetime('now') WHERE id = ?`).run(tags.join(', '), id)
  }

  /** Rimette in coda i brani cercati senza risultato (dopo qualche mese i servizi si arricchiscono). */
  tagRetry(service: 'dc' | 'lfm'): number {
    const [at, val] = service === 'dc' ? ['dc_at', 'dc_genres'] : ['lfm_at', 'lfm_tags']
    return Number(this.db.prepare(`UPDATE tracks SET ${at} = NULL WHERE ${val} = ''`).run().changes)
  }

  lfmArtistTags(name: string): string[] | null {
    const r = this.db.prepare('SELECT tags FROM lfm_artists WHERE name = ?').get(name.trim().toLowerCase()) as Row | undefined
    return r ? String(r.tags).split(', ').filter(Boolean) : null
  }

  saveLfmArtistTags(name: string, tags: string[]): void {
    this.db
      .prepare("INSERT OR REPLACE INTO lfm_artists(name, tags, checked_at) VALUES (?, ?, datetime('now'))")
      .run(name.trim().toLowerCase(), tags.join(', '))
  }

  /** AcoustID già provato per il brano (trovato o no). */
  markAcoustId(id: number): void {
    this.db.prepare("UPDATE tracks SET acoustid_at = datetime('now') WHERE id = ?").run(id)
  }

  /** Rimette in coda per MusicBrainz un brano preciso (per esempio appena scaricato dal server). */
  mbRequeue(id: number): void {
    this.db
      .prepare('UPDATE tracks SET mb_checked_at = NULL, mb_genres_at = NULL, acoustid_at = NULL, dc_at = NULL, lfm_at = NULL WHERE id = ?')
      .run(id)
  }

  /** Generi di un artista già letti da MusicBrainz (null = mai letti). */
  mbArtistGenres(id: string): string[] | null {
    const r = this.db.prepare('SELECT genres FROM mb_artists WHERE id = ?').get(id) as Row | undefined
    return r ? String(r.genres).split(', ').filter(Boolean) : null
  }

  saveMbArtistGenres(id: string, genres: string[]): void {
    this.db
      .prepare("INSERT OR REPLACE INTO mb_artists(id, genres, checked_at) VALUES (?, ?, datetime('now'))")
      .run(id, genres.join(', '))
  }

  /** Rimette in coda per MusicBrainz i brani già cercati ma ancora incompleti. */
  mbRetry(): number {
    return Number(this.db.prepare(`UPDATE tracks SET mb_checked_at = NULL WHERE ${MB_TODO}`).run().changes)
  }

  /** Musica attiva con dati mancanti per il report SIAE. */
  incompleteMusic(limit = 500): { tracks: Track[]; total: number } {
    const where = `kind = 'music' AND enabled = 1 AND (composer = '' OR publisher = '' OR (siae_code = '' AND iswc = '' AND isrc = ''))`
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${where}`).get() as Row).n)
    const tracks = (
      this.db
        .prepare(`SELECT * FROM tracks WHERE ${where} ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE LIMIT ?`)
        .all(limit) as Row[]
    ).map(rowToTrack)
    return { tracks, total }
  }

  /**
   * Chiude le voci rimaste aperte (chiusura del programma o crash). La durata trasmessa è il tempo dall'inizio
   * a `now`, al massimo la durata del brano (dopo un crash il programma può ripartire molto più tardi).
   */
  closeDanglingLog(now: Date): void {
    const rows = this.db
      .prepare(
        `SELECT l.id, l.started_at, t.duration FROM play_log l LEFT JOIN tracks t ON t.id = l.track_id
         WHERE l.ended_at IS NULL`
      )
      .all() as Row[]
    const stmt = this.db.prepare('UPDATE play_log SET ended_at = ?, played_seconds = ? WHERE id = ?')
    for (const r of rows) {
      let played = (now.getTime() - Date.parse(String(r.started_at))) / 1000
      if (!Number.isFinite(played) || played < 0) played = 0
      const duration = Number(r.duration)
      if (r.duration != null && duration > 0) played = Math.min(played, duration)
      stmt.run(now.toISOString(), Math.round(played * 10) / 10, Number(r.id))
    }
  }
}

/** Testo per la ricerca: minuscolo e senza accenti. I testi solo ASCII (la gran parte) non passano dalla normalizzazione. */
export function perRicerca(s: string): string {
  const low = s.toLowerCase()
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(low)) return low
  return low.normalize('NFD').replace(/\p{M}/gu, '')
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

function trimSep(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') || p : p
}

/** `p` è dentro la cartella `dir` (confine di cartella vero: "/musica" non contiene "/musica2/x.mp3"). */
function isUnder(p: string, dir: string): boolean {
  const d = trimSep(dir)
  if (!p.startsWith(d)) return false
  if (p.length === d.length) return true
  return /[\\/]$/.test(d) || p[d.length] === '/' || p[d.length] === '\\'
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/

/** Controlla un evento prima di salvarlo; gli errori sono in italiano per l'interfaccia. */
export function validateEvent(e: Omit<ScheduledEvent, 'id'>): void {
  if (!/^([01]\d|2[0-3]|\*):[0-5]\d$/.test(e.time)) throw new Error('Orario non valido, usa HH:MM')
  if (e.untilTime && !HM.test(e.untilTime)) throw new Error('Orario di fine ripetizioni non valido')
  // le ripetizioni non attraversano la mezzanotte: "fino alle" deve venire dopo l'orario di partenza
  if (e.repeatMinutes > 0 && e.untilTime && !e.time.startsWith('*') && e.untilTime <= e.time)
    throw new Error(
      `L'orario di fine ripetizioni (${e.untilTime}) deve essere dopo quello di partenza (${e.time}): le ripetizioni non possono passare la mezzanotte`
    )
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
