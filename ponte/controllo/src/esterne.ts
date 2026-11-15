/**
 * Ascolto del programma durante le dirette esterne: ffmpeg legge il flusso interno di Liquidsoap e
 * lo passa al riconoscimento (impronte a 5512 Hz e audio di qualità per i clip degli sconosciuti).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SAMPLE_RATE } from './impronta.ts'
import { CLIP_RATE, Recognizer, type FpStore, type Recognized, type Unknown, type UnknownStore } from './riconoscimento.ts'
import type { PlayLog } from './registro.ts'

interface Proc {
  stdout: NodeJS.ReadableStream | null
  stdio: (NodeJS.ReadableStream | NodeJS.WritableStream | null)[]
  stdin: NodeJS.WritableStream | null
  on(ev: 'exit', cb: (code: number | null) => void): void
  on(ev: 'error', cb: (e: Error) => void): void
  kill(): void
}
type Spawn = (cmd: string, args: string[], opts: { stdio: ('ignore' | 'pipe')[] }) => Proc

/** Un ingresso, due uscite: 5512 Hz su stdout (impronte), 22050 Hz sul descrittore 3 (clip). */
export function captureArgs(url: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url,
    '-filter_complex', '[0:a]aformat=channel_layouts=mono,asplit=2[a][b]',
    '-map', '[a]', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1',
    '-map', '[b]', '-ar', String(CLIP_RATE), '-f', 's16le', 'pipe:3'
  ]
}

/** Converte pezzi di PCM s16le in float, tenendo da parte il byte dispari tra un pezzo e l'altro. */
export class S16Reader {
  private rest: Buffer | null = null
  read(chunk: Buffer): Float32Array {
    const b = this.rest ? Buffer.concat([this.rest, chunk]) : chunk
    const n = b.length >> 1
    this.rest = b.length & 1 ? b.subarray(b.length - 1) : null
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = b.readInt16LE(i * 2) / 32768
    return out
  }
}

export interface EsterneDeps {
  fp: FpStore
  unknowns: UnknownStore
  playLog: PlayLog
  /** Indirizzo del flusso interno del programma. */
  url: string
  ffmpeg?: string
  spawn?: Spawn
  log?: (s: string) => void
  /** Avviso quando arriva un brano sconosciuto da etichettare. */
  onUnknown?: (count: number, u: Unknown) => void
}

export class EsterneRecognition {
  private proc: Proc | null = null
  private active = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly rec: Recognizer
  private readonly d: EsterneDeps
  private readonly spawn: Spawn
  private readonly ffmpeg: string
  private readonly log: (s: string) => void
  /** Ultimo brano riconosciuto (per il pannello). */
  last: { id: string; title: string; artist: string; at: string } | null = null

  constructor(d: EsterneDeps) {
    this.d = d
    this.spawn = d.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts) as unknown as Proc)
    this.ffmpeg = d.ffmpeg ?? 'ffmpeg'
    this.log = d.log ?? ((s) => console.log(`[riconoscimento] ${s}`))
    this.rec = new Recognizer({
      search: (q, w) => d.fp.index.search(q, w),
      onPlay: (r) => this.played(r),
      onUnknown: (clip, fp, at, seconds) =>
        void this.saveUnknown(clip, fp, at, seconds).catch((e: unknown) =>
          this.log(`brano sconosciuto non salvato: ${e instanceof Error ? e.message : String(e)}`)
        )
    })
  }

  isActive(): boolean {
    return this.active
  }

  /** Diretta esterna collegata o scollegata (eventi di Liquidsoap). */
  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    if (on) {
      this.log(`diretta esterna: ascolto avviato (${this.d.fp.list().length} impronte in archivio)`)
      this.start()
    } else {
      this.log('diretta esterna finita: ascolto fermato')
      if (this.restartTimer) clearTimeout(this.restartTimer)
      this.restartTimer = null
      const p = this.proc
      this.proc = null
      p?.kill()
      this.rec.end()
    }
  }

  private start(): void {
    this.restartTimer = null
    if (!this.active || this.proc) return
    const p = this.spawn(this.ffmpeg, captureArgs(this.d.url), { stdio: ['ignore', 'pipe', 'ignore', 'pipe'] })
    this.proc = p
    const lq = new S16Reader()
    const hq = new S16Reader()
    // dopo lo stop arrivano ancora pezzi già letti: non vanno nel riconoscimento (ripartito da zero)
    p.stdout?.on('data', (c: Buffer) => {
      if (this.proc !== p) return
      try {
        this.rec.push(lq.read(c))
      } catch (e) {
        // un errore qui (disco pieno, indice) non deve far cadere il server
        this.log(`errore nel riconoscimento: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
    ;(p.stdio[3] as NodeJS.ReadableStream | null)?.on('data', (c: Buffer) => {
      if (this.proc === p) this.rec.pushClip(hq.read(c))
    })
    // ffmpeg mancante o non avviabile: senza questo l'errore farebbe cadere il server
    p.on('error', (e) => {
      this.log(`ffmpeg non avviato: ${e.message}`)
      if (this.proc !== p) return
      this.proc = null
      if (this.active && !this.restartTimer) this.restartTimer = setTimeout(() => this.start(), 5000)
    })
    p.on('exit', () => {
      if (this.proc !== p) return
      this.proc = null
      // il flusso interno si è interrotto ma l'esterna è ancora collegata: si riprova
      if (this.active && !this.restartTimer) this.restartTimer = setTimeout(() => this.start(), 5000)
    })
  }

  private played(r: Recognized): void {
    if (r.id.startsWith('sconosciuto/')) {
      const u = this.d.unknowns.get(r.id)
      if (!u) return
      if (!u.label) {
        this.d.unknowns.heardAgain(r.id, r.at)
        this.log(`brano sconosciuto ${r.id} sentito di nuovo (ancora da etichettare)`)
        return
      }
      this.d.playLog.add({ at: r.at, source: 'esterna', id: r.id, title: u.label.title, artist: u.label.artist, duration: u.seconds, composer: u.label.composer, publisher: u.label.publisher })
    } else {
      const m = this.d.fp.get(r.id)
      this.d.playLog.add({ at: r.at, source: 'esterna', id: r.id, title: m?.title ?? r.title, artist: m?.artist ?? r.artist, duration: m?.duration ?? 0 })
    }
    this.last = { id: r.id, title: r.title, artist: r.artist, at: r.at }
    this.log(`riconosciuto: ${r.artist} - ${r.title} (${Math.round((1 - r.ber) * 100)}%)`)
  }

  private async saveUnknown(clip: { pcm: Float32Array; rate: number }, fp: Uint32Array, at: string, seconds: number): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'clip-'))
    const out = join(dir, 'clip.mp3')
    try {
      await this.encode(clip, out)
    } catch (e) {
      this.log(`clip non salvato: ${e instanceof Error ? e.message : String(e)}`)
    }
    let u: Unknown
    try {
      u = this.d.unknowns.add(at, seconds, fp, out)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    this.log(`nuovo brano sconosciuto ${u.id} (${Math.round(seconds)} s): da etichettare dal pannello`)
    this.d.onUnknown?.(this.d.unknowns.list().filter((x) => !x.label).length, u)
  }

  private encode(clip: { pcm: Float32Array; rate: number }, out: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = this.spawn(
        this.ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(clip.rate), '-ac', '1', '-i', 'pipe:0', '-b:a', '96k', '-y', out],
        { stdio: ['pipe', 'ignore', 'ignore'] }
      )
      p.on('error', reject)
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ha risposto ${code}`))))
      // ffmpeg che esce prima di leggere tutto (EPIPE): ci pensa 'exit'
      p.stdin?.on('error', () => {})
      p.stdin?.end(Buffer.from(clip.pcm.buffer, clip.pcm.byteOffset, clip.pcm.byteLength))
    })
  }
}
