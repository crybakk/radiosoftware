/**
 * Registrazione automatica delle puntate e taglio per la pubblicazione.
 *
 * Ogni 15 secondi si guarda se un programma con la registrazione attiva è nella sua fascia (con i
 * minuti di margine): se sì, ffmpeg legge il programma in onda dal flusso interno di Liquidsoap e lo
 * salva in registrazioni/<puntata>.mp3. Se ffmpeg si ferma (Liquidsoap riavviato, rete interna) riparte
 * da solo e accoda l'audio allo stesso file. A fine fascia la registrazione diventa una bozza.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createWriteStream, renameSync, rmSync, type WriteStream } from 'node:fs'
import { parseFile } from 'music-metadata'
import { activeSlot, type Episode, type Programs } from './programmi.ts'

export interface Proc {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(ev: 'exit', cb: (code: number | null) => void): void
  kill(): void
}
export type Spawn = (cmd: string, args: string[]) => Proc

const defaultSpawn: Spawn = (cmd, args) => nodeSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as Proc

/** Legge il programma in onda e lo scrive in MP3 sull'uscita standard. */
export function recordArgs(url: string, bitrate: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1', '-reconnect_delay_max', '5',
    '-i', url,
    '-vn', '-c:a', 'libmp3lame', '-b:a', bitrate, '-ar', '44100',
    '-f', 'mp3', 'pipe:1'
  ]
}

/** Taglio senza ricodifica: da `from` a `to` secondi. */
export function cutArgs(input: string, output: string, from: number, to: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', from.toFixed(2), '-to', to.toFixed(2),
    '-i', input,
    '-map', '0:a', '-c', 'copy', '-map_metadata', '-1',
    '-f', 'mp3', output
  ]
}

/** Durata di un MP3 in secondi (0 se non leggibile). */
export async function mp3Seconds(file: string): Promise<number> {
  try {
    const m = await parseFile(file, { duration: false, skipCovers: true })
    return Math.round(m.format.duration ?? 0)
  } catch {
    return 0
  }
}

export interface RecorderDeps {
  programs: Programs
  /** Flusso interno del programma (MP3 di Liquidsoap). */
  url: string
  bitrate?: string
  ffmpeg?: string
  spawn?: Spawn
  now?: () => number
  /** Durata della registrazione finita (sostituibile nei test). */
  seconds?: (file: string) => Promise<number>
  log?: (s: string) => void
  /** Nuova bozza da rivedere. */
  onDraft?: (e: Episode) => void
  /** Cambio dell'elenco delle registrazioni in corso. */
  onChange?: () => void
}

interface Running {
  episodeId: string
  programId: string
  to: number
  proc: Proc | null
  out: WriteStream
  stopping: boolean
  restart: ReturnType<typeof setTimeout> | null
}

export class Recorder {
  private readonly d: RecorderDeps
  private readonly spawn: Spawn
  private readonly now: () => number
  private readonly log: (s: string) => void
  private readonly running = new Map<string, Running>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(d: RecorderDeps) {
    this.d = d
    this.spawn = d.spawn ?? defaultSpawn
    this.now = d.now ?? (() => Date.now())
    this.log = d.log ?? ((s) => console.log(`[puntate] ${s}`))
  }

  start(intervalMs = 15_000): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), intervalMs)
  }

  /** Programmi che si stanno registrando, con l'ora di fine. */
  recording(): { programId: string; episodeId: string; to: number }[] {
    return [...this.running.values()].map((r) => ({ programId: r.programId, episodeId: r.episodeId, to: r.to }))
  }

  tick(): void {
    const now = this.now()
    const margin = this.d.programs.settings().marginMinutes
    for (const p of this.d.programs.list()) {
      const r = this.running.get(p.id)
      const slot = p.record ? activeSlot(p.slots, new Date(now), margin) : null
      if (r && (!slot || now >= r.to)) void this.finish(r)
      else if (!r && slot) this.begin(p.id, now, slot.to)
    }
    // programmi eliminati durante la registrazione
    for (const r of this.running.values()) if (!this.d.programs.get(r.programId)) void this.finish(r, true)
  }

  private begin(programId: string, now: number, to: number): void {
    const e = this.d.programs.startRecording(programId, now)
    const r: Running = {
      episodeId: e.id,
      programId,
      to,
      proc: null,
      out: createWriteStream(this.d.programs.rawFile(e.id), { flags: 'a' }),
      stopping: false,
      restart: null
    }
    this.running.set(programId, r)
    this.log(`registrazione avviata: ${e.title}`)
    this.launch(r)
    this.d.onChange?.()
  }

  private launch(r: Running): void {
    const proc = this.spawn(this.d.ffmpeg ?? 'ffmpeg', recordArgs(this.d.url, this.d.bitrate ?? '128k'))
    r.proc = proc
    proc.stdout?.on('data', (c: Buffer) => r.out.write(c))
    let err = ''
    proc.stderr?.on('data', (c: Buffer) => (err = (err + String(c)).slice(-500)))
    proc.on('exit', () => {
      if (r.proc !== proc) return
      r.proc = null
      if (r.stopping) return
      // ffmpeg si è fermato da solo: si riprova tra poco, accodando allo stesso file
      this.log(`ffmpeg fermo${err.trim() ? ` (${err.trim().split('\n').pop()})` : ''}: riparto tra 5 secondi`)
      r.restart = setTimeout(() => {
        r.restart = null
        if (!r.stopping) this.launch(r)
      }, 5000)
    })
  }

  private async finish(r: Running, discard = false): Promise<void> {
    if (r.stopping) return
    r.stopping = true
    if (r.restart) clearTimeout(r.restart)
    const exited = new Promise<void>((ok) => {
      if (!r.proc) return ok()
      r.proc.on('exit', () => ok())
      setTimeout(ok, 3000)
    })
    r.proc?.kill()
    await exited
    await new Promise<void>((ok) => r.out.end(ok))
    this.running.delete(r.programId)
    if (discard) {
      this.d.programs.removeEpisode(r.episodeId)
    } else {
      const length = await (this.d.seconds ?? mp3Seconds)(this.d.programs.rawFile(r.episodeId))
      const e = this.d.programs.endRecording(r.episodeId, this.now(), length)
      if (e) {
        this.log(`registrazione finita: ${e.title} (${Math.round(length / 60)} minuti), da rivedere`)
        this.d.onDraft?.(e)
      } else {
        this.log('registrazione finita senza audio: scartata')
      }
    }
    this.d.onChange?.()
  }

  /** Spegnimento: le registrazioni in corso diventano bozze. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await Promise.all([...this.running.values()].map((r) => this.finish(r)))
  }
}

/** Taglia la bozza tra inizio e fine (secondi) e la pubblica. */
export async function publishEpisode(
  programs: Programs,
  id: string,
  meta: { from: number; to: number; title: string; description: string },
  opts: { ffmpeg?: string; spawn?: Spawn; seconds?: (file: string) => Promise<number> } = {}
): Promise<Episode> {
  const e = programs.episode(id)
  if (!e) throw new Error('puntata non trovata')
  if (e.status !== 'bozza') throw new Error('si possono pubblicare solo le bozze')
  const from = Math.max(0, Number(meta.from) || 0)
  const to = Math.min(e.length || Infinity, Number(meta.to) || e.length)
  if (!(to - from >= 10)) throw new Error('la puntata deve durare almeno 10 secondi: controlla inizio e fine')
  const out = programs.episodeFile(id)
  const tmp = `${out}.tmp`
  const proc = (opts.spawn ?? defaultSpawn)(opts.ffmpeg ?? 'ffmpeg', cutArgs(programs.rawFile(id), tmp, from, to))
  let err = ''
  proc.stderr?.on('data', (c: Buffer) => (err = (err + String(c)).slice(-500)))
  const code = await new Promise<number | null>((ok) => proc.on('exit', ok))
  if (code !== 0) {
    rmSync(tmp, { force: true })
    throw new Error(`taglio non riuscito${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`)
  }
  renameSync(tmp, out)
  const length = (await (opts.seconds ?? mp3Seconds)(out)) || Math.round(to - from)
  return programs.published(id, { title: meta.title, description: meta.description, length })
}
