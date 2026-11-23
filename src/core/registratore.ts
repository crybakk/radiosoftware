/**
 * Registrazione in regia dei programmi fatti dallo studio.
 *
 * Registra lo stesso audio che la regia manda al ponte (il programma del computer oppure l'ingresso
 * della scheda audio, es. il mix del RodeCaster con i microfoni), in MP3 sul disco del PC di regia.
 * Così la puntata è completa anche quando il 4G perde dei pezzi. Se ffmpeg si ferma riparte da solo e
 * accoda l'audio allo stesso file (i fotogrammi MP3 si possono mettere uno dopo l'altro).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, mkdirSync, rmSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export interface Proc {
  stdin: NodeJS.WritableStream & { writableLength?: number; destroyed?: boolean; writable?: boolean }
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(ev: 'exit', cb: (code: number | null) => void): void
  kill(signal?: NodeJS.Signals): void
}
export type Spawn = (cmd: string, args: string[]) => Proc

const defaultSpawn: Spawn = (cmd, args) => {
  const c = nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const ev = new EventEmitter()
  let done = false
  const end = (code: number | null): void => {
    if (done) return
    done = true
    ev.emit('exit', code)
  }
  c.on('exit', (code) => end(code))
  // ffmpeg mancante o non avviabile: diventa una fine con codice null, mai un errore che fa cadere la regia
  c.on('error', () => end(null))
  c.stdin.on('error', () => {})
  return {
    stdin: c.stdin,
    stdout: c.stdout,
    stderr: c.stderr,
    on: (e: 'exit', cb: (code: number | null) => void) => void ev.on(e, cb),
    kill: (signal?: NodeJS.Signals) => {
      try {
        c.kill(signal)
      } catch {
        // già finito
      }
    }
  }
}

/** PCM s16le stereo dall'ingresso standard → MP3 sull'uscita standard. */
export function recordArgs(sampleRate: number, bitrateKbps: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 's16le', '-ar', String(sampleRate), '-ac', '2', '-i', 'pipe:0',
    '-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrateKbps}k`, '-ar', '44100',
    '-f', 'mp3', 'pipe:1'
  ]
}

/** Nome del file: data e ora di inizio più il titolo, senza caratteri che Windows non accetta. */
export function recordingFileName(title: string, start: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())} ${p(start.getHours())}.${p(start.getMinutes())}`
  const clean = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80)
  return `${stamp}${clean ? ` ${clean}` : ''}.mp3`
}

/** Sotto questa dimensione il file ha solo l'intestazione MP3 (meno di un decimo di secondo di audio). */
const MIN_BYTES = 4096

export interface RecordingStatus {
  active: boolean
  title: string
  /** Programma del pannello a cui appartiene la registrazione, se scelto. */
  programId: string | null
  /** Inizio (ISO). */
  since: string | null
  file: string | null
  bytes: number
  /** Ultimo problema (ffmpeg fermo, audio che non arriva...), null se tutto bene. */
  problem: string | null
}

export interface FinishedRecording {
  title: string
  programId: string | null
  file: string
  startedAt: string
  endedAt: string
  bytes: number
}

export interface RecorderOptions {
  dir: string
  ffmpeg: string
  bitrateKbps?: number
  spawn?: Spawn
  now?: () => number
  log?: (s: string) => void
}

interface Running {
  title: string
  programId: string | null
  file: string
  since: number
  out: WriteStream
  proc: Proc | null
  stopping: boolean
  broken: boolean
  restart: ReturnType<typeof setTimeout> | null
  sampleRate: number
}

export class StudioRecorder {
  private readonly o: RecorderOptions
  private readonly spawn: Spawn
  private readonly now: () => number
  private readonly log: (s: string) => void
  private r: Running | null = null
  private problem: string | null = null
  private sampleRate = 0
  private readonly listeners = new Set<(s: RecordingStatus) => void>()
  private readonly finishedListeners = new Set<(f: FinishedRecording) => void>()

  constructor(o: RecorderOptions) {
    this.o = o
    this.spawn = o.spawn ?? defaultSpawn
    this.now = o.now ?? (() => Date.now())
    this.log = o.log ?? ((s) => console.log(`[registrazione] ${s}`))
  }

  onStatus(cb: (s: RecordingStatus) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  onFinished(cb: (f: FinishedRecording) => void): () => void {
    this.finishedListeners.add(cb)
    return () => this.finishedListeners.delete(cb)
  }

  status(): RecordingStatus {
    const r = this.r
    let bytes = 0
    if (r) {
      try {
        bytes = statSync(r.file).size
      } catch {
        // file non ancora creato
      }
    }
    return {
      active: !!r,
      title: r?.title ?? '',
      programId: r?.programId ?? null,
      since: r ? new Date(r.since).toISOString() : null,
      file: r?.file ?? null,
      bytes,
      problem: this.problem
    }
  }

  private emit(): void {
    const s = this.status()
    for (const l of this.listeners) l(s)
  }

  /** Frequenza dell'audio che arriva dall'interfaccia (0 = cattura ferma). */
  setSampleRate(sampleRate: number): void {
    this.sampleRate = sampleRate
    const r = this.r
    // la scheda audio è cambiata: ffmpeg deve ripartire con la frequenza giusta, sullo stesso file
    if (r && sampleRate > 0 && sampleRate !== r.sampleRate) {
      r.sampleRate = sampleRate
      r.proc?.kill()
    }
  }

  start(title: string, programId: string | null = null): RecordingStatus {
    if (this.r) throw new Error('c\'è già una registrazione in corso: fermala prima')
    mkdirSync(this.o.dir, { recursive: true })
    const since = this.now()
    const name = (title || '').trim() || 'Registrazione'
    const file = join(this.o.dir, recordingFileName(name, new Date(since)))
    const r: Running = {
      title: name,
      programId,
      file,
      since,
      out: createWriteStream(file, { flags: 'a' }),
      proc: null,
      stopping: false,
      broken: false,
      restart: null,
      sampleRate: this.sampleRate
    }
    r.out.on('error', (err) => {
      if (r.broken) return
      r.broken = true
      this.problem = `il file non si scrive: ${err.message}`
      this.log(`registrazione di ${r.title} interrotta: ${err.message}`)
      r.proc?.kill()
      this.emit()
    })
    this.r = r
    this.problem = null
    this.log(`registrazione avviata: ${name}`)
    this.launch(r)
    this.emit()
    return this.status()
  }

  /** Audio PCM s16le stereo: lo stesso che va al ponte. */
  write(pcm: Uint8Array): void {
    const p = this.r?.proc
    if (!p || p.stdin.destroyed || p.stdin.writable === false) return
    // ffmpeg bloccato (disco lentissimo): meglio perdere un pezzo che riempire la memoria
    if ((p.stdin.writableLength ?? 0) > 8 * 1024 * 1024) return
    p.stdin.write(pcm)
  }

  private launch(r: Running): void {
    if (r.broken || r.stopping || this.r !== r) return
    const rate = r.sampleRate || this.sampleRate || 48000
    r.sampleRate = rate
    const proc = this.spawn(this.o.ffmpeg, recordArgs(rate, this.o.bitrateKbps ?? 320))
    r.proc = proc
    proc.stdout?.pipe(r.out, { end: false })
    let err = ''
    proc.stderr?.on('data', (c: Buffer) => (err = (err + String(c)).slice(-500)))
    proc.on('exit', () => {
      if (r.proc !== proc) return
      r.proc = null
      if (r.stopping || r.broken) return
      const why = err.trim().split('\n').pop()
      if (why) {
        this.problem = `ffmpeg si è fermato (${why}): riparte da solo`
        this.log(`ffmpeg fermo (${why}): riparto tra 2 secondi`)
        this.emit()
      }
      r.restart = setTimeout(() => {
        r.restart = null
        this.launch(r)
      }, why ? 2000 : 0)
    })
  }

  /** Ferma la registrazione; restituisce il file finito (null se non c'era o se è vuoto). */
  async stop(): Promise<FinishedRecording | null> {
    const r = this.r
    if (!r || r.stopping) return null
    r.stopping = true
    if (r.restart) clearTimeout(r.restart)
    const proc = r.proc
    if (proc) {
      const exited = new Promise<boolean>((ok) => {
        proc.on('exit', () => ok(true))
        setTimeout(() => ok(false), 5000)
      })
      // chiudere l'ingresso fa finire ffmpeg in modo pulito (ultimo pezzo di MP3 scritto)
      try {
        proc.stdin.end()
      } catch {
        // già chiuso
      }
      if (!(await exited)) proc.kill('SIGKILL')
      await new Promise((ok) => setImmediate(ok))
      proc.stdout?.unpipe(r.out)
    }
    await new Promise<void>((ok) => {
      if (r.out.destroyed || r.out.writableFinished) return ok()
      r.out.once('close', () => ok())
      r.out.end()
      setTimeout(ok, 5000)
    })
    this.r = null
    let bytes = 0
    try {
      bytes = statSync(r.file).size
    } catch {
      // nessun file
    }
    const done: FinishedRecording = {
      title: r.title,
      programId: r.programId,
      file: r.file,
      startedAt: new Date(r.since).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
      bytes
    }
    this.log(`registrazione finita: ${r.title} (${Math.round((this.now() - r.since) / 60000)} minuti)`)
    this.emit()
    // solo l'intestazione, nessun audio arrivato: niente da tenere né da inviare
    if (bytes < MIN_BYTES) {
      rmSync(r.file, { force: true })
      return null
    }
    for (const l of this.finishedListeners) l(done)
    return done
  }
}
