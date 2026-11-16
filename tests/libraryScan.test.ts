import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import ffmpegStatic from 'ffmpeg-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeFile } from '../src/core/analyzer'
import { RadioDb } from '../src/core/db'
import { readFileInfo, scanLibrary } from '../src/core/scanner'
import { LibraryService } from '../src/main/library'

const ffmpeg = ffmpegStatic as unknown as string
let dir: string
function mp3(path: string, extra: string[] = [], seconds = 3): void {
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}:r=44100`, ...extra,
    '-b:a', '128k', path
  ])
}
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'radio-scan-'))
  for (const d of ['musica', 'natale', 'natale2', 'nas', join('nas', 'sotto'), 'scarico', 'fuori']) mkdirSync(join(dir, d))
  mp3(join(dir, 'musica', "L'amore # 100% è?.mp3"), ['-metadata', 'title=CITTÀ VUOTA', '-metadata', 'artist=Mina'])
  mp3(join(dir, 'musica', 'b.mp3'), ['-metadata', 'title=Originale'])
  mp3(join(dir, 'natale', 'jingle bells.mp3'))
  mp3(join(dir, 'natale2', 'altro.mp3'))
  mp3(join(dir, 'nas', 'n1.mp3'))
  mp3(join(dir, 'nas', 'sotto', 'n2.mp3'))
  mp3(join(dir, 'scarico', 's1.mp3'))
  mp3(join(dir, 'scarico', 's2.mp3'))
  mp3(join(dir, 'fuori', 'nuovo.mp3'))
  writeFileSync(join(dir, 'musica', 'vuoto.mp3'), '')
  writeFileSync(join(dir, 'musica', 'finto.mp3'), 'questo non è audio '.repeat(100))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('scansione della libreria', () => {
  it('una nuova scansione non riabilita i brani disabilitati a mano e non cambia il tipo scelto a mano', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'musica'), 'music')
    await scanLibrary(db)
    const t = db.searchTracks({ text: 'Mina' }).tracks[0]
    db.updateTrack(t.id, { enabled: false })
    const o = db.searchTracks({ text: 'Originale' }).tracks[0]
    db.updateTrack(o.id, { kind: 'jingle' })
    await scanLibrary(db)
    expect(db.getTrack(t.id)!.enabled).toBe(false)
    expect(db.getTrack(o.id)!.kind).toBe('jingle')
    // il tipo della cartella vale ancora per i brani non toccati a mano
    db.addFolder(join(dir, 'musica'), 'program')
    await scanLibrary(db)
    expect(db.getTrack(o.id)!.kind).toBe('jingle')
    expect(db.getTrack(t.id)!.kind).toBe('program')
    db.close()
  })

  it('un brano disabilitato perché il file era sparito torna disponibile quando il file ricompare', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'natale2'), 'music')
    await scanLibrary(db)
    const file = join(dir, 'natale2', 'altro.mp3')
    renameSync(file, file + '.bak')
    try {
      expect((await scanLibrary(db)).disabled).toBe(1)
      expect(db.findByPath(file)!.enabled).toBe(false)
    } finally {
      renameSync(file + '.bak', file)
    }
    await scanLibrary(db)
    expect(db.findByPath(file)!.enabled).toBe(true)
    db.close()
  })

  it('togliere una cartella disabilita i suoi brani, ma non quelli di cartelle con nome simile', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'natale'), 'music')
    db.addFolder(join(dir, 'natale2'), 'music')
    await scanLibrary(db)
    const natale = db.listFolders().find((f) => f.path.endsWith('natale'))!
    db.removeFolder(natale.id)
    await scanLibrary(db)
    const paths = db.rotationCandidates('music').map((t) => t.path)
    expect(paths.some((p) => p.includes(`natale${'/'}`) || p.includes('natale\\'))).toBe(false)
    expect(paths).toContain(join(dir, 'natale2', 'altro.mp3'))
    // rimessa la cartella, i brani tornano disponibili
    db.addFolder(join(dir, 'natale'), 'music')
    await scanLibrary(db)
    expect(db.rotationCandidates('music')).toHaveLength(2)
    db.close()
  })

  it('una cartella che non si riesce a leggere (NAS spento) non disabilita i suoi brani e conta come errore', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'nas'), 'music')
    await scanLibrary(db)
    expect(db.libraryStats().total).toBe(2)
    renameSync(join(dir, 'nas'), join(dir, 'nas-spento'))
    let p
    try {
      p = await scanLibrary(db)
    } finally {
      renameSync(join(dir, 'nas-spento'), join(dir, 'nas'))
    }
    expect(p.disabled).toBe(0)
    expect(p.errors).toBe(1)
    expect(db.libraryStats().total).toBe(2)
    db.close()
  })

  it('i file vuoti o non audio non entrano in libreria e contano come errori', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'musica'), 'music')
    const p = await scanLibrary(db)
    expect(p.added).toBe(2)
    expect(p.errors).toBe(2)
    expect(db.findByPath(join(dir, 'musica', 'vuoto.mp3'))).toBeNull()
    expect(db.findByPath(join(dir, 'musica', 'finto.mp3'))).toBeNull()
    db.close()
  })

  it('un brano aggiunto alla libreria durante la scansione (scaricato dal server) non viene disabilitato', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'scarico'), 'music')
    const target = join(dir, 'scarico', 'nuovo.mp3')
    const info = await readFileInfo(join(dir, 'fuori', 'nuovo.mp3'), 'music')
    const fileState = db.fileState.bind(db)
    let first = true
    // la cartella è già stata letta: il file arriva "dopo", come un download di serverSync
    db.fileState = (p) => {
      if (first) {
        first = false
        renameSync(join(dir, 'fuori', 'nuovo.mp3'), target)
        db.upsertScanned({ ...info, path: target })
      }
      return fileState(p)
    }
    try {
      const p = await scanLibrary(db)
      expect(p.disabled).toBe(0)
      expect(db.findByPath(target)!.enabled).toBe(true)
    } finally {
      renameSync(target, join(dir, 'fuori', 'nuovo.mp3'))
    }
    db.close()
  })

  it('una cartella tolta durante la scansione non torna in rotazione', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'scarico'), 'music')
    await scanLibrary(db)
    const folder = db.listFolders()[0]
    const fileState = db.fileState.bind(db)
    let first = true
    db.fileState = (p) => {
      if (first) {
        first = false
        db.removeFolder(folder.id)
      }
      return fileState(p)
    }
    await scanLibrary(db)
    expect(db.rotationCandidates('music')).toHaveLength(0)
    db.close()
  })

  it('la ricerca ignora maiuscole, minuscole e accenti', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'musica'), 'music')
    await scanLibrary(db)
    expect(db.searchTracks({ text: 'CITTÀ' }).total).toBe(1)
    expect(db.searchTracks({ text: 'città vuota' }).total).toBe(1)
    expect(db.searchTracks({ text: 'mina città' }).total).toBe(1)
    // anche senza accenti ("citta" trova "CITTÀ")
    expect(db.searchTracks({ text: 'citta' }).total).toBe(1)
    // % e _ restano caratteri normali
    expect(db.searchTracks({ text: '%' }).total).toBe(0)
    expect(db.searchTracks({ text: '_' }).total).toBe(0)
    db.close()
  })
})

describe('analisi in background', () => {
  it('se ffmpeg fallisce e la durata è 0 il brano viene disabilitato', async () => {
    const db = new RadioDb(':memory:')
    const base = {
      kind: 'music' as const, size: 1, mtime: 1, title: 'X', artist: '', album: '', year: null, genre: '',
      composer: '', publisher: '', isrc: '', bitrate: 0, sampleRate: 44100
    }
    const zero = db.upsertScanned({ ...base, path: join(dir, 'zero.mp3'), duration: 0 })
    const tagged = db.upsertScanned({ ...base, path: join(dir, 'tag.mp3'), duration: 180 })
    await new LibraryService(db, join(dir, 'ffmpeg-che-non-esiste')).analyzeAll()
    expect(db.getTrack(zero)!.enabled).toBe(false)
    expect(db.getTrack(tagged)!).toMatchObject({ enabled: true, cueOut: 180 })
    expect(db.getTrack(tagged)!.analyzedAt).not.toBeNull()
    db.close()
  })

  it('ffmpeg viene fermato allo scadere del tempo e quando si annulla', async () => {
    const file = join(dir, 'musica', 'b.mp3')
    await expect(analyzeFile(ffmpeg, file, undefined, 1)).rejects.toThrow(/entro/)
    const ctrl = new AbortController()
    const p = analyzeFile(ffmpeg, file, ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect((await analyzeFile(ffmpeg, file)).duration).toBeGreaterThan(2.9)
  })

  it('stop() interrompe l’analisi senza segnare il brano come analizzato', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'natale'), 'music')
    await scanLibrary(db)
    const lib = new LibraryService(db, ffmpeg)
    const run = lib.analyzeAll()
    lib.stop()
    await run
    expect(db.countPendingAnalysis()).toBe(1)
    db.close()
  })
})

describe('database esistente', () => {
  it('aggiunge le colonne nuove ai database delle versioni precedenti', () => {
    const file = join(dir, 'vecchio.db')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE tracks (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'music',
      title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '', year INTEGER,
      genre TEXT NOT NULL DEFAULT '', composer TEXT NOT NULL DEFAULT '', publisher TEXT NOT NULL DEFAULT '',
      isrc TEXT NOT NULL DEFAULT '', iswc TEXT NOT NULL DEFAULT '', siae_code TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL DEFAULT 0, bitrate INTEGER NOT NULL DEFAULT 0, sample_rate INTEGER NOT NULL DEFAULT 0,
      loudness REAL, cue_in REAL NOT NULL DEFAULT 0, cue_out REAL NOT NULL DEFAULT 0, mix_point REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, file_size INTEGER NOT NULL DEFAULT 0, file_mtime REAL NOT NULL DEFAULT 0,
      analyzed_at TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO tracks(path, title, enabled) VALUES ('/a.mp3', 'Città', 0);`)
    old.close()
    const db = new RadioDb(file)
    const cols = (db.db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['missing', 'kind_manual']))
    // i brani già disabilitati restano disabilitati
    expect(db.findByPath('/a.mp3')!.enabled).toBe(false)
    db.close()
    // riaprire non rifà la migrazione
    new RadioDb(file).close()
  })
})
