import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { RadioDb } from './db'
import type { EngineStep } from './playout'
import { AUDIO_EXTENSIONS, readFileInfo } from './scanner'
import type { ScheduledEvent, Track } from './types'

/** Effetti esterni, separati per poterli sostituire nei test. */
export interface EventEffects {
  runCommand(command: string): void
  now(): Date
  /** Puntata da mandare in replica (dal server); null se non c'è. */
  replay?(programId: string, episodeId?: string): Promise<Track | null>
  /** Notiziario da mandare in onda (scaricato al momento); track null = niente, note spiega perché. */
  news?(sourceId: string): Promise<{ track: Track | null; note: string }>
  /** Annuncio con la voce sintetica (testo con le parti tra graffe ancora da riempire). */
  voice?(text: string): Promise<{ track: Track | null; note: string }>
}

/** Estrae i percorsi da una playlist M3U/M3U8 o PLS. I percorsi relativi sono rispetto alla playlist. */
export function parsePlaylist(text: string, playlistPath: string): string[] {
  const base = dirname(playlistPath)
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const isPls = lines.some((l) => /^\[playlist\]/i.test(l.trim()))
  const out: string[] = []
  for (const raw of lines) {
    let line = raw.trim()
    if (!line) continue
    if (isPls) {
      const m = /^File\d+=(.+)$/i.exec(line)
      if (!m) continue
      line = m[1].trim()
    } else if (line.startsWith('#')) {
      continue
    }
    if (/^file:\/\//i.test(line)) line = decodeURIComponent(line.replace(/^file:\/\/\/?/i, process.platform === 'win32' ? '' : '/'))
    if (/^https?:\/\//i.test(line)) continue
    const winAbs = /^[a-zA-Z]:[\\/]/.test(line) || line.startsWith('\\\\')
    out.push(winAbs || isAbsolute(line) ? line : resolve(base, line))
  }
  return out
}

let lastStreamId = 0

/** Brano "virtuale" per un flusso esterno: suona per `minutes` minuti. */
export function streamTrack(url: string, minutes: number, title: string): Track {
  const seconds = Math.max(1, minutes) * 60
  return {
    // negativo e sempre diverso, anche per due flussi creati nello stesso millisecondo
    id: (lastStreamId = Math.min(-Date.now(), lastStreamId - 1)),
    path: url.trim(),
    kind: 'program',
    title: title.trim() || 'Flusso esterno',
    artist: url.trim(),
    album: '',
    year: null,
    genre: '',
    composer: '',
    publisher: '',
    isrc: '',
    iswc: '',
    mbGenres: '',
    dcGenres: '',
    lfmTags: '',
    userTags: '',
    siaeCode: '',
    duration: seconds,
    bitrate: 0,
    sampleRate: 0,
    loudness: null,
    cueIn: 0,
    cueOut: seconds,
    mixPoint: seconds,
    enabled: true,
    analyzedAt: null,
    addedAt: new Date().toISOString()
  }
}

/** Brano "virtuale" per la replica di una puntata (audio in streaming dal server). */
export function replayTrack(program: { title: string }, episode: { title: string; length: number; path: string }): Track {
  const t = streamTrack(episode.path, episode.length / 60, `Replica: ${episode.title}`)
  const seconds = Math.max(1, Math.round(episode.length))
  return { ...t, artist: program.title, duration: seconds, cueOut: seconds, mixPoint: seconds }
}

/** Brano "virtuale" per un notiziario scaricato (file locale, non entra nella libreria). */
export function newsTrack(name: string, item: { file: string; title: string; duration: number; publishedAt: number }): Track {
  const seconds = Math.max(1, Math.round(item.duration || 300))
  return {
    ...streamTrack(item.file, seconds / 60, item.title || name),
    kind: 'news',
    artist: name,
    duration: seconds,
    cueOut: seconds,
    mixPoint: seconds
  }
}

/** Brano "virtuale" per un annuncio con la voce sintetica (file locale). */
export function voiceTrack(text: string, file: string, seconds: number): Track {
  const words = text.replace(/\s+/g, ' ').trim()
  return {
    ...streamTrack(file, seconds / 60, words.length > 60 ? `${words.slice(0, 57)}…` : words),
    kind: 'jingle',
    artist: 'Annuncio vocale',
    duration: seconds,
    cueOut: seconds,
    mixPoint: seconds
  }
}

/** Sceglie la puntata da replicare: quella indicata o la più recente. */
export function pickReplay(
  programs: { id: string; title: string; episodes: { id: string; title: string; length: number; path: string }[] }[],
  programId: string,
  episodeId?: string
): Track | null {
  const p = programs.find((x) => x.id === programId)
  const e = p && (episodeId ? p.episodes.find((x) => x.id === episodeId) : p.episodes[0])
  return p && e ? replayTrack(p, e) : null
}

async function playlistTracks(db: RadioDb, path: string): Promise<{ tracks: Track[]; missing: number }> {
  let files: string[]
  const st = await stat(path)
  if (st.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true })
    files = entries
      .filter((e) => e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => join(path, e.name))
      .sort((a, b) => a.localeCompare(b, 'it', { numeric: true }))
  } else {
    files = parsePlaylist(await readFile(path, 'utf8'), path)
  }
  const tracks: Track[] = []
  let missing = 0
  const ci = process.platform === 'win32'
  for (const f of files) {
    let t = db.findByPath(f, ci)
    if (!t) {
      try {
        // file fuori dalla libreria: lo aggiungiamo (verrà analizzato in background)
        const id = db.upsertScanned(await readFileInfo(f, 'music'))
        t = db.getTrack(id)
      } catch {
        t = null
      }
    }
    if (t) tracks.push(t)
    else missing++
  }
  return { tracks, missing }
}

/**
 * Tempo massimo per preparare notiziario e annuncio vocale: oltre si salta (il lavoro continua da solo,
 * es. la voce che si scarica la prima volta, e sarà pronto la volta dopo) e l'evento va avanti.
 */
export const EXTERNAL_TIMEOUT_MS = 3 * 60_000

function inTime<T>(p: Promise<T>, what: string, slow: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} troppo ${slow} (più di ${EXTERNAL_TIMEOUT_MS / 60_000} minuti): saltato`)), EXTERNAL_TIMEOUT_MS)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/** Traduce le azioni di un evento in passi per il motore, eseguendo quelle "esterne". */
export async function expandEvent(db: RadioDb, event: ScheduledEvent, fx: EventEffects): Promise<EngineStep[]> {
  const steps: EngineStep[] = []
  // brani consecutivi "in testa" vengono raggruppati per mantenere l'ordine
  const front: Track[] = []
  const flush = (): void => {
    if (front.length) steps.push({ kind: 'tracks', tracks: front.splice(0), placement: 'front' })
  }
  for (const a of event.actions) {
    switch (a.type) {
      case 'play': {
        const t = db.getTrack(a.trackId)
        if (t) front.push(t)
        else steps.push({ kind: 'error', message: 'brano non trovato nella libreria' })
        break
      }
      case 'random': {
        const t = db.randomTrack(a, new Date(fx.now().getTime() - 24 * 3600_000))
        if (t) front.push(t)
        else steps.push({ kind: 'error', message: 'nessun brano corrisponde ai filtri del brano casuale' })
        break
      }
      case 'stream':
        front.push(streamTrack(a.url, a.minutes, a.title))
        break
      case 'playlist': {
        flush()
        try {
          const { tracks, missing } = await playlistTracks(db, a.path)
          if (tracks.length) steps.push({ kind: 'tracks', tracks, placement: a.placement })
          if (missing) steps.push({ kind: 'error', message: `${missing} file della playlist non trovati` })
          if (!tracks.length && !missing) steps.push({ kind: 'error', message: 'playlist vuota' })
        } catch {
          steps.push({ kind: 'error', message: `playlist non leggibile: ${a.path}` })
        }
        break
      }
      case 'mode':
        flush()
        steps.push({ kind: 'mode', mode: a.mode })
        break
      case 'clear':
        flush()
        steps.push({ kind: 'clear' })
        break
      case 'stop':
        flush()
        steps.push({ kind: 'stop' })
        break
      case 'rotation':
        db.saveSettings({ rotationProfile: a.profile })
        break
      case 'djMix':
        db.saveSettings({ djMix: a.on })
        break
      case 'replay': {
        let t: Track | null = null
        let why = 'nessuna puntata pubblicata'
        try {
          t = fx.replay ? await fx.replay(a.programId) : null
        } catch (err) {
          why = err instanceof Error ? err.message : String(err)
        }
        if (t) front.push(t)
        else steps.push({ kind: 'error', message: `replica di "${a.title || a.programId}" non disponibile: ${why}` })
        break
      }
      case 'news': {
        let r: { track: Track | null; note: string } = { track: null, note: 'notiziari non disponibili' }
        try {
          if (fx.news) r = await inTime(fx.news(a.sourceId), 'scaricamento', 'lento')
        } catch (err) {
          r = { track: null, note: err instanceof Error ? err.message : String(err) }
        }
        if (r.track) front.push(r.track)
        else steps.push({ kind: 'error', message: `notiziario "${a.title || a.sourceId}": ${r.note}` })
        break
      }
      case 'voice': {
        let r: { track: Track | null; note: string } = { track: null, note: 'voce sintetica non disponibile' }
        try {
          if (fx.voice) r = await inTime(fx.voice(a.text), 'preparazione', 'lenta')
        } catch (err) {
          r = { track: null, note: err instanceof Error ? err.message : String(err) }
        }
        if (r.track) front.push(r.track)
        else steps.push({ kind: 'error', message: `annuncio vocale: ${r.note}` })
        if (r.track && r.note) steps.push({ kind: 'error', message: `annuncio vocale: ${r.note}` })
        break
      }
      case 'command':
        try {
          fx.runCommand(a.command)
        } catch (err) {
          steps.push({ kind: 'error', message: `comando non eseguito: ${err instanceof Error ? err.message : err}` })
        }
        break
    }
  }
  flush()
  return steps
}
