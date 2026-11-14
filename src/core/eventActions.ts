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

/** Brano "virtuale" per un flusso esterno: suona per `minutes` minuti. */
export function streamTrack(url: string, minutes: number, title: string): Track {
  const seconds = Math.max(1, minutes) * 60
  return {
    id: -Date.now(),
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
