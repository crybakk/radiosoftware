import { DatabaseSync } from 'node:sqlite'
import { DJ_ANALYSIS_VERSION, type DjAnalysis } from './djAnalysis'
import { CUE_ANALYSIS_VERSION } from './musicBounds'
import { resolve } from 'node:path'
import { chiaveDoppione, copiaDaTenere, motivoNonRadiofonico } from './pulizia'
import { SECONDI_LIVE } from './liveAudio'
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

/**
 * Toglie trigger e viste da un database: la regia non ne usa, quindi in un backup arrivato da fuori
 * sarebbero codice estraneo che gira a ogni modifica (per esempio per riaccendere gli eventi spenti).
 */
export function dropSchemaCode(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')").all() as Row[]
  for (const r of rows) db.exec(`DROP ${r.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS "${String(r.name).replace(/"/g, '""')}"`)
  return rows.map((r) => String(r.name))
}

/** Prepara un backup scaricato prima di aprirlo come database della regia. */
export function sanitizeRestoredFile(file: string): void {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA trusted_schema = OFF')
    dropSchemaCode(db)
  } finally {
    db.close()
  }
}

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
  return rowToTrackWith(r, true)
}

/** Senza gli "uno" delle battute: per le liste lunghe, come i candidati della rotazione (pesano). */
function rowToTrackLight(r: Row): Track {
  return rowToTrackWith(r, false)
}

function rowToTrackWith(r: Row, beats: boolean): Track {
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
    userTags: r.user_tags == null ? '' : String(r.user_tags),
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
    addedAt: String(r.added_at),
    dj: r.dj_at == null ? null : rowToDj(r, beats)
  }
}

function rowToDj(r: Row, beats: boolean): DjAnalysis {
  return {
    bpm: Number(r.bpm ?? 0),
    firstDownbeat: Number(r.dj_downbeat ?? 0),
    gridConfidence: Number(r.dj_grid ?? 0),
    key: String(r.music_key ?? ''),
    energy: Number(r.energy ?? 0),
    introEnd: Number(r.intro_end ?? 0),
    outroStart: Number(r.outro_start ?? 0),
    ...(beats ? parseDownbeats(r.dj_beats) : {})
  }
}

function parseDownbeats(v: unknown): { downbeats?: number[] } {
  if (typeof v !== 'string' || !v) return {}
  try {
    const a = JSON.parse(v) as unknown
    return Array.isArray(a) && a.length >= 2 && a.every((x) => typeof x === 'number') ? { downbeats: a as number[] } : {}
  } catch {
    return {}
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
  /** Filtri per campo (ognuno contiene il testo, senza maiuscole e accenti). */
  title?: string
  artist?: string
  album?: string
  genre?: string
  yearFrom?: number | null
  yearTo?: number | null
  /** Ordine dei risultati (predefinito: artista e titolo). */
  sort?: 'artista' | 'titolo' | 'anno' | 'durata' | 'aggiunti'
  kind?: TrackKind
  /** Solo i brani di questa categoria (genere del file, dei servizi o etichetta tua). */
  category?: string
  limit?: number
  offset?: number
}

const ORDINI: Record<string, string> = {
  artista: 'artist COLLATE NOCASE, title COLLATE NOCASE',
  titolo: 'title COLLATE NOCASE, artist COLLATE NOCASE',
  anno: 'year IS NULL, year DESC, artist COLLATE NOCASE, title COLLATE NOCASE',
  durata: 'duration DESC, artist COLLATE NOCASE',
  aggiunti: 'added_at DESC, id DESC'
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
    | 'userTags'
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
  mixPoint: 'mix_point',
  userTags: 'user_tags'
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
    // v0.11: etichette scritte a mano (categorie tue per le rotazioni)
    if (!cols.includes('user_tags')) this.db.exec("ALTER TABLE tracks ADD COLUMN user_tags TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('acoustid_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN acoustid_at TEXT')
    this.db.exec('CREATE TABLE IF NOT EXISTS lfm_artists (name TEXT PRIMARY KEY, tags TEXT NOT NULL, checked_at TEXT NOT NULL)')
    this.db.exec('CREATE TABLE IF NOT EXISTS mb_artists (id TEXT PRIMARY KEY, genres TEXT NOT NULL, checked_at TEXT NOT NULL)')
    // v0.10: campi corretti a mano (titolo, artista, ..., punti di mix); nei database esistenti nessuno è segnato
    if (!cols.includes('manual_fields')) this.db.exec('ALTER TABLE tracks ADD COLUMN manual_fields INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('fp_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN fp_at TEXT')
    // v0.12: pulizia della libreria. "radio_ok" = segnalato come non radiofonico ma tu hai detto che va bene;
    // "orig_path" = da dove è stato spostato il file messo negli scarti (per rimetterlo a posto)
    if (!cols.includes('radio_ok')) this.db.exec('ALTER TABLE tracks ADD COLUMN radio_ok INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('orig_path')) this.db.exec("ALTER TABLE tracks ADD COLUMN orig_path TEXT NOT NULL DEFAULT ''")
    // live riconosciuti dal suono (secondi di applausi a inizio/fine) e titoli giudicati dall'AI locale
    if (!cols.includes('live_s')) this.db.exec('ALTER TABLE tracks ADD COLUMN live_s REAL')
    if (!cols.includes('live_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN live_at TEXT')
    if (!cols.includes('ai_motivo')) this.db.exec("ALTER TABLE tracks ADD COLUMN ai_motivo TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('ai_at')) this.db.exec('ALTER TABLE tracks ADD COLUMN ai_at TEXT')
    // analisi "da DJ" (Mix DJ, rotazione per energia): una colonna per dato, così si può cercare per BPM o energia
    for (const [col, def] of [
      ['bpm', 'REAL NOT NULL DEFAULT 0'],
      ['dj_downbeat', 'REAL NOT NULL DEFAULT 0'],
      ['dj_grid', 'REAL NOT NULL DEFAULT 0'],
      ['music_key', "TEXT NOT NULL DEFAULT ''"],
      ['energy', 'INTEGER NOT NULL DEFAULT 0'],
      ['intro_end', 'REAL NOT NULL DEFAULT 0'],
      ['outro_start', 'REAL NOT NULL DEFAULT 0'],
      ['dj_at', 'TEXT'],
      // "uno" di ogni battuta (JSON) e versione dell'analisi: le analisi vecchie si rifanno in background
      ['dj_beats', "TEXT NOT NULL DEFAULT ''"],
      ['dj_ver', 'INTEGER NOT NULL DEFAULT 0'],
      // versione del calcolo di inizio/fine: con la 2 si tolgono anche parlato, applausi e tracce fantasma
      ['cue_ver', 'INTEGER NOT NULL DEFAULT 0']
    ] as const) {
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE tracks ADD COLUMN ${col} ${def}`)
    }
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

  /**
   * Condizione SQL che nasconde la musica più lunga della durata massima (premixati, mix):
   * niente libreria, rotazioni, categorie, ricerche online, impronte, server. Durata 0 = sconosciuta: resta.
   * I brani restano nel database e ricompaiono se si alza il limite.
   */
  private short(alias = ''): string {
    return this.notLong(alias)
  }

  /**
   * Brani che la regia può scegliere da sola (rotazioni, brani a caso degli eventi): oltre alla durata massima
   * conta anche quella minima netta. I brani più corti restano in libreria e si possono mettere a mano.
   */
  private auto(alias = ''): string {
    const parts = [this.notLong(alias), this.notShort(alias)].filter((c) => c !== '1')
    return parts.length ? `(${parts.join(' AND ')})` : '1'
  }

  /** Solo la durata massima (lorda: un premixato resta un premixato). */
  private notLong(alias = ''): string {
    const min = Number(this.getSettings().maxTrackMinutes)
    if (!Number.isFinite(min) || min <= 0) return '1'
    return `(${alias}kind != 'music' OR ${alias}duration <= ${Math.round(min * 60)})`
  }

  /** Solo la durata minima, netta: dall'inizio alla fine della musica (prima dell'analisi vale la durata del file). */
  private notShort(alias = ''): string {
    const sec = Number(this.getSettings().minTrackSeconds)
    if (!Number.isFinite(sec) || sec <= 0) return '1'
    const net = `(CASE WHEN ${alias}cue_out > ${alias}cue_in THEN ${alias}cue_out - ${alias}cue_in ELSE ${alias}duration END)`
    return `(${alias}kind != 'music' OR ${alias}duration <= 0 OR ${net} >= ${Math.round(sec)})`
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
    if (!Array.isArray(out.djStyles)) out.djStyles = [...DEFAULT_SETTINGS.djStyles]
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

  /** Nuovo percorso dello stesso file (per esempio rinominato cambiando solo le maiuscole su Windows). */
  renameTrackPath(id: number, path: string): void {
    this.db.prepare('UPDATE tracks SET path = ? WHERE id = ?').run(path, id)
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
             duration=?, bitrate=?, sample_rate=?, file_size=?, file_mtime=?, analyzed_at=NULL, fp_at=NULL, live_at=NULL, dj_at=NULL
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
    const old = this.db.prepare('SELECT cue_in, cue_out FROM tracks WHERE id = ?').get(id) as Row | undefined
    this.db
      .prepare(
        `UPDATE tracks SET duration=?, loudness=?, ${unlessManual('cue_in', 'cueIn')}, ${unlessManual('cue_out', 'cueOut')},
           ${unlessManual('mix_point', 'mixPoint')}, cue_ver=?, analyzed_at=datetime('now') WHERE id=?`
      )
      .run(a.duration, a.loudness, a.cueIn, a.cueOut, a.mixPoint, CUE_ANALYSIS_VERSION, id)
    // inizio o fine spostati: l'analisi DJ (battiti, intro, outro) va rifatta dentro i punti nuovi
    const now = this.db.prepare('SELECT cue_in, cue_out FROM tracks WHERE id = ?').get(id) as Row | undefined
    if (old && now && (Math.abs(Number(old.cue_in) - Number(now.cue_in)) > 0.3 || Math.abs(Number(old.cue_out) - Number(now.cue_out)) > 0.3)) {
      this.db.prepare('UPDATE tracks SET dj_at = NULL WHERE id = ?').run(id)
    }
  }

  /**
   * Brani da analizzare: mai analizzati, o musica analizzata con un calcolo di inizio/fine più vecchio
   * (si rifà in background). Conta solo la durata massima: quella minima dipende proprio dall'analisi.
   */
  pendingAnalysis(limit = 50): Track[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tracks WHERE enabled = 1 AND ${this.notLong()} AND (analyzed_at IS NULL OR (kind = 'music' AND cue_ver < ?))
           ORDER BY (analyzed_at IS NOT NULL), id LIMIT ?`
        )
        .all(CUE_ANALYSIS_VERSION, limit) as Row[]
    ).map(rowToTrack)
  }

  /** Musica analizzata (inizio/fine) ma non ancora con l'analisi "da DJ". */
  pendingDj(limit = 20): Track[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tracks WHERE kind = 'music' AND enabled = 1 AND ${this.short()} AND analyzed_at IS NOT NULL
             AND (dj_at IS NULL OR dj_ver < ?)
           ORDER BY (dj_at IS NOT NULL), (bpm = 0), id LIMIT ?`
        )
        .all(DJ_ANALYSIS_VERSION, limit) as Row[]
    ).map(rowToTrack)
  }

  djStats(): { done: number; total: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN dj_at IS NOT NULL AND dj_ver >= ? THEN 1 ELSE 0 END) AS done FROM tracks WHERE kind = 'music' AND enabled = 1 AND ${this.short()}`
      )
      .get(DJ_ANALYSIS_VERSION) as Row
    return { done: Number(r.done ?? 0), total: Number(r.total ?? 0) }
  }

  /** null = file non analizzabile: segnato come fatto (senza griglia) per non riprovarlo finché il file non cambia. */
  saveDj(id: number, a: DjAnalysis | null): void {
    const d: DjAnalysis = a ?? { bpm: 0, firstDownbeat: 0, gridConfidence: 0, key: '', energy: 0, introEnd: 0, outroStart: 0 }
    this.db
      .prepare(
        `UPDATE tracks SET bpm=?, dj_downbeat=?, dj_grid=?, music_key=?, energy=?, intro_end=?, outro_start=?, dj_beats=?, dj_ver=?, dj_at=datetime('now') WHERE id=?`
      )
      .run(
        d.bpm,
        d.firstDownbeat,
        d.gridConfidence,
        d.key,
        d.energy,
        d.introEnd,
        d.outroStart,
        d.downbeats?.length ? JSON.stringify(d.downbeats) : '',
        DJ_ANALYSIS_VERSION,
        id
      )
  }

  countPendingAnalysis(): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tracks WHERE enabled = 1 AND ${this.notLong()} AND (analyzed_at IS NULL OR (kind = 'music' AND cue_ver < ?))`)
      .get(CUE_ANALYSIS_VERSION) as Row
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
    // titolo o interprete corretti a mano: l'abbinamento a MusicBrainz era probabilmente sbagliato,
    // quindi si toglie e il brano torna in coda per MusicBrainz, AcoustID, Discogs e Last.fm
    // (gli autori già scritti restano: sono campi protetti solo se corretti a mano)
    const renamed = before && ((edit.title !== undefined && edit.title !== before.title) || (edit.artist !== undefined && edit.artist !== before.artist))
    if (renamed) {
      sets.push("mb_recording_id = ''", 'mb_checked_at = NULL', 'mb_genres_at = NULL', 'acoustid_at = NULL', 'dc_at = NULL', 'lfm_at = NULL')
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
    const where: string[] = ['enabled = 1', this.short()]
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
    const field = (col: string, v: string | undefined): void => {
      for (const w of String(v ?? '').slice(0, 100).trim().split(/\s+/).filter(Boolean).slice(0, 5)) {
        where.push(`minuscolo(${col}) LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLike(perRicerca(w))}%`)
      }
    }
    field('title', q.title)
    field('artist', q.artist)
    field('album', q.album)
    field("genre || ',' || mb_genres || ',' || dc_genres || ',' || lfm_tags || ',' || user_tags", q.genre)
    if (q.yearFrom != null && Number.isFinite(Number(q.yearFrom))) {
      where.push('year >= ?')
      params.push(Number(q.yearFrom))
    }
    if (q.yearTo != null && Number.isFinite(Number(q.yearTo))) {
      where.push('year <= ?')
      params.push(Number(q.yearTo))
    }
    if (q.category?.trim()) {
      where.push("minuscolo(genre || ',' || mb_genres || ',' || dc_genres || ',' || lfm_tags || ',' || user_tags) LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(q.category.trim().toLowerCase())}%`)
    }
    const clause = where.join(' AND ')
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${clause}`).get(...params) as Row).n
    )
    const tracks = (
      this.db
        .prepare(`SELECT * FROM tracks WHERE ${clause} ORDER BY ${ORDINI[q.sort ?? 'artista'] ?? ORDINI.artista} LIMIT ? OFFSET ?`)
        .all(...params, q.limit ?? 200, q.offset ?? 0) as Row[]
    ).map(rowToTrack)
    return { tracks, total }
  }

  // ---------- pulizia della libreria ----------

  /**
   * Musica in libreria che non sembra radiofonica (Track 01, live@, titoli che non sono titoli), col motivo.
   * Esclusi i brani per cui hai detto "va bene così".
   */
  daControllare(limit = 2000): { tracks: (Track & { motivo: string })[]; total: number } {
    const rows = this.db
      .prepare(`SELECT * FROM tracks WHERE kind = 'music' AND enabled = 1 AND radio_ok = 0 AND ${this.short()} ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE`)
      .all() as Row[]
    const out: (Track & { motivo: string })[] = []
    let total = 0
    for (const r of rows) {
      const t = rowToTrack(r)
      const live = r.live_s == null ? 0 : Number(r.live_s)
      const motivo =
        motivoNonRadiofonico(t) ??
        (live >= SECONDI_LIVE ? `live (dal suono: ${live} s di applausi)` : null) ??
        (r.ai_motivo ? `secondo l'AI: ${String(r.ai_motivo)}` : null)
      if (!motivo) continue
      total++
      if (out.length < limit) out.push({ ...t, motivo })
    }
    return { tracks: out, total }
  }

  /**
   * Doppioni nella musica in libreria: gruppi di brani con lo stesso artista e titolo, con la copia da tenere
   * per prima. Esclusi i brani per cui hai detto "va bene così".
   */
  doppioni(limit = 1000): { gruppi: { tieni: number; tracks: Track[] }[]; total: number } {
    const rows = this.db
      .prepare(`SELECT * FROM tracks WHERE kind = 'music' AND enabled = 1 AND radio_ok = 0 AND ${this.short()}`)
      .all() as Row[]
    const byKey = new Map<string, Track[]>()
    for (const r of rows) {
      const t = rowToTrack(r)
      const k = chiaveDoppione(t)
      if (!k) continue
      const g = byKey.get(k)
      if (g) g.push(t)
      else byKey.set(k, [t])
    }
    const gruppi = [...byKey.values()]
      .filter((g) => g.length > 1)
      .map((g) => {
        const tieni = copiaDaTenere(g)
        return { tieni: tieni.id, tracks: [tieni, ...g.filter((t) => t.id !== tieni.id)] }
      })
      .sort((a, b) => a.tracks[0].artist.localeCompare(b.tracks[0].artist) || a.tracks[0].title.localeCompare(b.tracks[0].title))
    return { gruppi: gruppi.slice(0, limit), total: gruppi.length }
  }

  /** Musica ancora da ascoltare per riconoscere i live dal suono. */
  pendingLive(limit = 20): Track[] {
    return (
      this.db
        .prepare(`SELECT * FROM tracks WHERE kind = 'music' AND enabled = 1 AND radio_ok = 0 AND ${this.short()} AND live_at IS NULL ORDER BY id LIMIT ?`)
        .all(limit) as Row[]
    ).map(rowToTrack)
  }

  /** Secondi di applausi trovati (null = file non leggibile: non si riprova finché il file non cambia). */
  saveLive(id: number, seconds: number | null): void {
    this.db.prepare("UPDATE tracks SET live_s = ?, live_at = datetime('now') WHERE id = ?").run(seconds, id)
  }

  liveStats(): { done: number; total: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN live_at IS NOT NULL THEN 1 ELSE 0 END) AS done FROM tracks WHERE kind = 'music' AND enabled = 1 AND radio_ok = 0 AND ${this.short()}`
      )
      .get() as Row
    return { done: Number(r.done ?? 0), total: Number(r.total ?? 0) }
  }

  /** Musica da far giudicare all'AI: non ancora vista e non già segnalata dalle regole. */
  pendingAiTitoli(limit = 30): Track[] {
    const out: Track[] = []
    const rows = this.db
      .prepare(`SELECT * FROM tracks WHERE kind = 'music' AND enabled = 1 AND radio_ok = 0 AND ${this.short()} AND ai_at IS NULL ORDER BY id`)
      .iterate() as Iterable<Row>
    const skip: number[] = []
    for (const r of rows) {
      const t = rowToTrack(r)
      // già nella lista per le regole: non serve chiedere all'AI
      if (motivoNonRadiofonico(t)) skip.push(t.id)
      else out.push(t)
      if (out.length >= limit) break
    }
    const stmt = this.db.prepare("UPDATE tracks SET ai_at = datetime('now') WHERE id = ?")
    for (const id of skip) stmt.run(id)
    return out
  }

  /** Giudizio dell'AI: motivo per i titoli non adatti, '' per quelli a posto. */
  saveAiTitoli(results: { id: number; motivo: string }[]): void {
    const stmt = this.db.prepare("UPDATE tracks SET ai_motivo = ?, ai_at = datetime('now') WHERE id = ?")
    for (const r of results) stmt.run(r.motivo.slice(0, 80), r.id)
  }

  aiTitoliStats(): { done: number; total: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN ai_at IS NOT NULL THEN 1 ELSE 0 END) AS done FROM tracks WHERE kind = 'music' AND enabled = 1 AND radio_ok = 0 AND ${this.short()}`
      )
      .get() as Row
    return { done: Number(r.done ?? 0), total: Number(r.total ?? 0) }
  }

  /** Rifà da capo il giudizio dell'AI su tutta la musica. */
  resetAiTitoli(): void {
    this.db.exec("UPDATE tracks SET ai_at = NULL, ai_motivo = ''")
  }

  /** "Va bene così": il brano non compare più tra quelli da controllare (on = false lo rimette). */
  segnaRadiofonico(ids: number[], on = true): number {
    const stmt = this.db.prepare('UPDATE tracks SET radio_ok = ? WHERE id = ?')
    let n = 0
    for (const id of ids) n += Number(stmt.run(on ? 1 : 0, Number(id)).changes)
    return n
  }

  /**
   * Toglie i brani dalla libreria senza toccare il file: escono da rotazioni, ricerca e server.
   * È una scelta tua: la scansione non li rimette (missing = 0).
   */
  togliDallaLibreria(ids: number[]): number {
    const stmt = this.db.prepare('UPDATE tracks SET enabled = 0, missing = 0 WHERE id = ? AND enabled = 1')
    let n = 0
    for (const id of ids) n += Number(stmt.run(Number(id)).changes)
    return n
  }

  /** Rimette in libreria i brani tolti a mano (non quelli col file sparito). */
  rimettiInLibreria(ids: number[]): number {
    const stmt = this.db.prepare("UPDATE tracks SET enabled = 1, missing = 0, orig_path = '' WHERE id = ? AND enabled = 0 AND missing = 0")
    let n = 0
    for (const id of ids) n += Number(stmt.run(Number(id)).changes)
    return n
  }

  /** Brani tolti a mano dalla libreria (con il percorso originale se il file è stato spostato negli scarti). */
  toltiDallaLibreria(text = '', limit = 500): { tracks: (Track & { origPath: string })[]; total: number } {
    const where = ['enabled = 0', 'missing = 0']
    const params: (string | number)[] = []
    for (const w of String(text).slice(0, 200).trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("minuscolo(title || ' ' || artist || ' ' || album || ' ' || path) LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(perRicerca(w))}%`)
    }
    const clause = where.join(' AND ')
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${clause}`).get(...params) as Row).n)
    const tracks = (
      this.db.prepare(`SELECT * FROM tracks WHERE ${clause} ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE LIMIT ?`).all(...params, limit) as Row[]
    ).map((r) => ({ ...rowToTrack(r), origPath: String(r.orig_path ?? '') }))
    return { tracks, total }
  }

  /** Il file è stato spostato negli scarti: nuovo percorso, quello vecchio per rimetterlo a posto, e fuori dalla libreria. */
  spostatoNegliScarti(id: number, path: string, origPath: string): void {
    this.db.prepare('UPDATE tracks SET path = ?, orig_path = ?, enabled = 0, missing = 0 WHERE id = ?').run(path, origPath, id)
  }

  /** Percorso originale di un brano spostato negli scarti ('' = non spostato). */
  percorsoOriginale(id: number): string {
    const r = this.db.prepare('SELECT orig_path FROM tracks WHERE id = ?').get(id) as Row | undefined
    return r ? String(r.orig_path ?? '') : ''
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

  /** Brani candidati per la rotazione automatica (senza gli "uno" delle battute: per il Mix DJ si rileggono con getTracks). */
  rotationCandidates(kind: TrackKind): Track[] {
    return (this.db.prepare(`SELECT * FROM tracks WHERE kind = ? AND enabled = 1 AND ${this.auto()}`).all(kind) as Row[]).map(rowToTrackLight)
  }

  libraryStats(): {
    total: number
    byKind: Record<string, number>
    pendingAnalysis: number
    hiddenLong: number
    maxTrackMinutes: number
    /** Musica che resta in libreria ma la regia non sceglie da sola (meno musica della durata minima netta). */
    hiddenShort: number
    minTrackSeconds: number
  } {
    const rows = this.db
      .prepare(`SELECT kind, COUNT(*) AS n FROM tracks WHERE enabled = 1 AND ${this.short()} GROUP BY kind`)
      .all() as Row[]
    const byKind: Record<string, number> = {}
    let total = 0
    for (const r of rows) {
      byKind[String(r.kind)] = Number(r.n)
      total += Number(r.n)
    }
    const hiddenBy = (ok: string): number =>
      ok === '1' ? 0 : Number((this.db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE enabled = 1 AND NOT ${ok}`).get() as Row).n)
    const s = this.getSettings()
    return {
      total,
      byKind,
      pendingAnalysis: this.countPendingAnalysis(),
      hiddenLong: hiddenBy(this.notLong()),
      maxTrackMinutes: s.maxTrackMinutes,
      hiddenShort: Number(
        (this.db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE enabled = 1 AND ${this.notLong()} AND NOT ${this.notShort()}`).get() as Row).n
      ),
      minTrackSeconds: s.minTrackSeconds
    }
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
    // prima via eventuali trigger del backup, che potrebbero annullare lo spegnimento
    dropSchemaCode(this.db)
    const off = this.listEvents().filter((e) => e.enabled && e.actions.some((a) => a?.type === 'command'))
    const stmt = this.db.prepare('UPDATE schedule SET enabled = 0 WHERE id = ?')
    for (const e of off) stmt.run(e.id)
    if (this.listEvents().some((e) => e.enabled && e.actions.some((a) => a?.type === 'command'))) {
      throw new Error('ripristino: non è stato possibile spegnere gli eventi con un comando esterno')
    }
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
    const where = ['enabled = 1', this.auto()]
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
      // genere del file, dei servizi o etichetta tua, senza badare alle maiuscole
      where.push("minuscolo(genre || ',' || mb_genres || ',' || dc_genres || ',' || lfm_tags || ',' || user_tags) LIKE ? ESCAPE '\\'")
      params.push(`%${f.genre.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`)
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
    const ok = this.short()
    const rows = this.db
      .prepare(
        `SELECT genre AS g FROM tracks WHERE enabled = 1 AND ${ok} AND genre != '' UNION SELECT mb_genres FROM tracks WHERE enabled = 1 AND ${ok} AND mb_genres != '' ` +
          `UNION SELECT dc_genres FROM tracks WHERE enabled = 1 AND ${ok} AND dc_genres != '' UNION SELECT lfm_tags FROM tracks WHERE enabled = 1 AND ${ok} AND lfm_tags != '' ` +
          `UNION SELECT user_tags FROM tracks WHERE enabled = 1 AND ${ok} AND user_tags != ''`
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
        .prepare(`SELECT * FROM tracks WHERE kind = 'music' AND enabled = 1 AND ${this.short()} AND fp_at IS NULL ORDER BY id LIMIT ?`)
        .all(limit) as Row[]
    ).map(rowToTrack)
  }

  fingerprintStats(): { done: number; total: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN fp_at IS NOT NULL THEN 1 ELSE 0 END) AS done FROM tracks WHERE kind = 'music' AND enabled = 1 AND ${this.short()}`
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
           WHERE t.kind = 'music' AND t.enabled = 1 AND ${this.short('t.')} AND t.fp_at IS NOT NULL`
        )
        .all() as Row[]
    ).map((r) => ({ track: rowToTrack(r), bytes: Number(r.fp_bytes) }))
  }

  getFingerprint(id: number): Uint8Array | null {
    const r = this.db.prepare('SELECT fp FROM fingerprints WHERE track_id = ?').get(id) as Row | undefined
    return r ? (r.fp as Uint8Array) : null
  }

  // ---------- categorie ed etichette ----------

  /** Categorie della musica attiva con il numero di brani; mine = c'è almeno un brano con l'etichetta scritta a mano. */
  categories(): { name: string; count: number; mine: boolean }[] {
    const rows = this.db
      .prepare(`SELECT genre, mb_genres, dc_genres, lfm_tags, user_tags FROM tracks WHERE kind = 'music' AND enabled = 1 AND ${this.short()}`)
      .all() as Row[]
    const map = new Map<string, { name: string; count: number; mine: boolean }>()
    for (const r of rows) {
      const seen = new Set<string>()
      const mine = new Set(String(r.user_tags).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
      for (const col of [r.genre, r.mb_genres, r.dc_genres, r.lfm_tags, r.user_tags]) {
        for (const g of String(col ?? '').split(/[,;/]/)) {
          const k = g.trim().toLowerCase()
          if (!k || seen.has(k)) continue
          seen.add(k)
          const c = map.get(k) ?? { name: k, count: 0, mine: false }
          c.count++
          if (mine.has(k)) c.mine = true
          map.set(k, c)
        }
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'it'))
  }

  /** Mette o toglie un'etichetta tua su più brani; restituisce quanti brani sono cambiati. */
  setUserTag(ids: number[], tag: string, on: boolean): number {
    const t = tag.trim().toLowerCase().replace(/[,;/]+/g, ' ').replace(/\s+/g, ' ').slice(0, 40)
    if (!t) return 0
    const get = this.db.prepare('SELECT user_tags FROM tracks WHERE id = ?')
    const set = this.db.prepare('UPDATE tracks SET user_tags = ? WHERE id = ?')
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const id of ids.slice(0, 5000)) {
        const r = get.get(id) as Row | undefined
        if (!r) continue
        const list = String(r.user_tags).split(',').map((x) => x.trim()).filter(Boolean)
        const has = list.includes(t)
        if (has === on) continue
        set.run((on ? [...list, t] : list.filter((x) => x !== t)).join(', '), id)
        n++
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return n
  }

  // ---------- MusicBrainz ----------

  /** Musica a cui manca qualche dato per il report SIAE e non ancora cercata su MusicBrainz. */
  mbPending(limit = 20, acoustId = false): MbTrack[] {
    // con AcoustID tornano in coda anche i brani cercati per titolo senza trovarli e mai provati dall'audio
    const where = acoustId ? `(${MB_PENDING}) OR (${MB_ACOUSTID})` : MB_PENDING
    return (this.db.prepare(`SELECT * FROM tracks WHERE (${where}) AND ${this.short()} ORDER BY id LIMIT ?`).all(limit) as Row[]).map(rowToMbTrack)
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
         FROM tracks WHERE kind = 'music' AND enabled = 1 AND ${this.short()}`
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
        .prepare(`SELECT * FROM tracks WHERE kind = 'music' AND enabled = 1 AND ${this.short()} AND ${col} IS NULL ORDER BY id LIMIT ?`)
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
         FROM tracks WHERE kind = 'music' AND enabled = 1 AND ${this.short()}`
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
    const where = `kind = 'music' AND enabled = 1 AND ${this.short()} AND (composer = '' OR publisher = '' OR (siae_code = '' AND iswc = '' AND isrc = ''))`
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
