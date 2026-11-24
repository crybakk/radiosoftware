/**
 * Registrazione sul computer dell'audio del mixer, in MP3 320 kbit/s (come la regia dello studio).
 * La finestra manda pezzi WebM/Opus ad alta qualità; ffmpeg li converte e scrive il file man mano,
 * così anche se l'app si chiude di colpo il file resta leggibile fino a quel punto.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface Proc {
  stdin: NodeJS.WritableStream | null
  stderr: NodeJS.ReadableStream | null
  on(ev: 'exit', cb: (code: number | null) => void): void
  on(ev: 'error', cb: (e: Error) => void): void
  kill(): void
}
type Spawn = (cmd: string, args: string[], opts: { stdio: ('ignore' | 'pipe')[] }) => Proc

/** Nome del file: "2026-11-24 18.30 Programma.mp3" (senza caratteri vietati su Windows e Mac). */
export function nomeFile(titolo: string, d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const t = titolo.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Diretta esterna'
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())} ${t}.mp3`
}

export function argomentiFfmpeg(file: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'webm', '-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '48000', '-y', file]
}

export interface RegistratoreDeps {
  ffmpeg: string
  spawn?: Spawn
  /** Chiede alla finestra di avviare o fermare la registrazione ad alta qualità (MediaRecorder). */
  pezzi: (on: boolean) => void
  log?: (s: string) => void
}

export class Registratore {
  private readonly d: RegistratoreDeps
  private readonly spawn: Spawn
  private proc: Proc | null = null
  private file: string | null = null
  private inizio: number | null = null
  private problema: string | null = null
  private finito: Promise<void> | null = null
  private haAudio = false

  constructor(d: RegistratoreDeps) {
    this.d = d
    this.spawn = d.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts) as unknown as Proc)
  }

  attivo(): boolean {
    return this.proc !== null
  }

  /** Avvia una registrazione nella cartella `dir`. */
  avvia(dir: string, titolo: string): string {
    if (this.proc) throw new Error('c\'è già una registrazione in corso')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, nomeFile(titolo, new Date()))
    const p = this.spawn(this.d.ffmpeg, argomentiFfmpeg(file), { stdio: ['pipe', 'ignore', 'pipe'] })
    this.proc = p
    this.file = file
    this.inizio = Date.now()
    this.problema = null
    this.haAudio = false
    let err = ''
    p.stderr?.on('data', (c: Buffer) => (err = (err + String(c)).slice(-400)))
    p.stdin?.on('error', () => {})
    this.finito = new Promise((ok) => {
      p.on('exit', (code) => {
        if (this.proc === p) {
          // ffmpeg si è fermato da solo: la registrazione non va avanti
          this.problema = `registrazione interrotta${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`
          this.proc = null
          this.d.pezzi(false)
        }
        if (code !== 0 && code !== null) this.d.log?.(`ffmpeg ha risposto ${code}: ${err.trim()}`)
        ok()
      })
      p.on('error', (e) => {
        this.problema = `ffmpeg non parte: ${e.message}`
        if (this.proc === p) this.proc = null
        ok()
      })
    })
    this.d.pezzi(true)
    return file
  }

  pezzo(b: Buffer): void {
    const p = this.proc
    if (!p?.stdin) return
    // il primo pezzo deve essere l'inizio del file WebM
    if (!this.haAudio && (b.length < 4 || b.readUInt32BE(0) !== 0x1a45dfa3)) return
    this.haAudio = true
    p.stdin.write(b)
  }

  /** Ferma la registrazione e aspetta che il file sia chiuso. */
  async ferma(): Promise<{ file: string; inizio: number; fine: number; byte: number } | null> {
    const p = this.proc
    const file = this.file
    const inizio = this.inizio
    this.d.pezzi(false)
    if (!p || !file || inizio === null) return null
    this.proc = null
    // gli ultimi pezzi arrivano dalla finestra dopo lo stop del MediaRecorder: un attimo di margine
    await new Promise((ok) => setTimeout(ok, 400))
    try {
      p.stdin?.end()
    } catch {
      // già chiuso
    }
    const t = setTimeout(() => p.kill(), 10_000)
    await this.finito
    clearTimeout(t)
    let byte = 0
    try {
      byte = statSync(file).size
    } catch {
      return null
    }
    if (!this.haAudio || byte < 1000) return null
    return { file, inizio, fine: Date.now(), byte }
  }

  stato(): { attiva: boolean; file: string | null; inizio: number | null; byte: number; problema: string | null } {
    let byte = 0
    if (this.file) {
      try {
        byte = statSync(this.file).size
      } catch {
        byte = 0
      }
    }
    return { attiva: this.proc !== null, file: this.file, inizio: this.inizio, byte, problema: this.problema }
  }
}
