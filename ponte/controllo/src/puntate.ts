/**
 * Registrazione automatica delle puntate e taglio per la pubblicazione.
 *
 * Ogni 15 secondi si guarda se un programma con la registrazione attiva è nella sua fascia (con i
 * minuti di margine): se sì, ffmpeg legge il programma in onda dal flusso interno di Liquidsoap e lo
 * salva in registrazioni/<puntata>.mp3. Se ffmpeg si ferma (Liquidsoap riavviato, rete interna) riparte
 * da solo e accoda l'audio allo stesso file. A fine fascia la registrazione diventa una bozza.
 * Se il server si spegne di colpo e riparte dentro la stessa fascia, la puntata continua nello stesso
 * file; altrimenti la registrazione interrotta resta una bozza con la durata letta dal file.
 * Con il disco quasi pieno (noSpace) non si avvia nessuna registrazione nuova.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, renameSync, rmSync, type WriteStream } from 'node:fs'
import { parseFile } from 'music-metadata'
import { activeSlot, type Episode, type Programs } from './programmi.ts'

export interface Proc {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(ev: 'exit', cb: (code: number | null) => void): void
  kill(signal?: NodeJS.Signals): void
}
export type Spawn = (cmd: string, args: string[]) => Proc

/**
 * ffmpeg come processo figlio. Se non parte (programma mancante, troppi processi aperti) Node segnala
 * un "error" e nessun "exit": senza ascoltatori farebbe cadere il server, e chi aspetta la fine
 * aspetterebbe per sempre. Qui l'errore diventa una fine con codice null, segnalata una volta sola.
 */
const defaultSpawn: Spawn = (cmd, args) => {
  const c = nodeSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const ev = new EventEmitter()
  let done = false
  const end = (code: number | null): void => {
    if (done) return
    done = true
    ev.emit('exit', code)
  }
  c.on('exit', (code) => end(code))
  c.on('error', () => end(null))
  return {
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
  /** Motivo per non registrare (disco quasi pieno), null se si può. Si ricontrolla a ogni giro. */
  noSpace?: () => string | null
}

/**
 * Bozze rimaste da registrazioni interrotte all'improvviso (server spento di colpo): la durata non
 * era stata scritta, la si legge dal file.
 */
export async function fixInterrupted(programs: Programs, seconds: (file: string) => Promise<number> = mp3Seconds): Promise<void> {
  for (const e of programs.interruptedDrafts()) {
    const length = await seconds(programs.rawFile(e.id)).catch(() => 0)
    programs.setInterruptedLength(e.id, length)
  }
}

interface Running {
  episodeId: string
  programId: string
  to: number
  proc: Proc | null
  out: WriteStream
  stopping: boolean
  /** Il file non si può più scrivere (disco pieno...): si smette di registrare. */
  broken: boolean
  restart: ReturnType<typeof setTimeout> | null
}

export class Recorder {
  private readonly d: RecorderDeps
  private readonly spawn: Spawn
  private readonly now: () => number
  private readonly log: (s: string) => void
  private readonly running = new Map<string, Running>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** Programmi già segnalati nel log come "non registrati per il disco pieno". */
  private readonly noSpaceLogged = new Set<string>()

  constructor(d: RecorderDeps) {
    this.d = d
    this.spawn = d.spawn ?? defaultSpawn
    this.now = d.now ?? (() => Date.now())
    this.log = d.log ?? ((s) => console.log(`[puntate] ${s}`))
  }

  start(intervalMs = 15_000): void {
    // prima si riprendono le registrazioni interrotte nella fascia in corso, poi si sistemano le altre
    this.tick()
    this.timer = setInterval(() => this.tick(), intervalMs)
    void fixInterrupted(this.d.programs, this.d.seconds ?? mp3Seconds).catch((err: unknown) => this.fail('durata delle registrazioni interrotte', err))
  }

  private fail(what: string, err: unknown): void {
    this.log(`${what}: ${err instanceof Error ? err.message : String(err)}`)
  }

  /** Programmi che si stanno registrando, con l'ora di fine. */
  recording(): { programId: string; episodeId: string; to: number }[] {
    return [...this.running.values()].map((r) => ({ programId: r.programId, episodeId: r.episodeId, to: r.to }))
  }

  tick(): void {
    const now = this.now()
    const margin = this.d.programs.settings().marginMinutes
    for (const p of this.d.programs.list()) {
      // un errore (disco pieno...) non deve fermare il controllo degli altri programmi né far cadere il server
      try {
        const r = this.running.get(p.id)
        const slot = p.record ? activeSlot(p.slots, new Date(now), margin) : null
        // fascia allungata o fascia attaccata alla successiva: si continua nello stesso file
        if (r && !r.stopping && slot && slot.to > r.to) r.to = slot.to
        if (r && (!slot || now >= r.to)) void this.finish(r)
        else if (!r && slot) {
          const full = this.d.noSpace?.() ?? null
          if (full) {
            if (!this.noSpaceLogged.has(p.id)) this.log(`registrazione di ${p.title} non avviata: ${full}`)
            this.noSpaceLogged.add(p.id)
            continue
          }
          this.noSpaceLogged.delete(p.id)
          this.begin(p.id, now, slot)
        }
      } catch (err) {
        this.fail(`registrazione di ${p.title}`, err)
      }
    }
    // programmi eliminati durante la registrazione
    for (const r of this.running.values()) if (!this.d.programs.get(r.programId)) void this.finish(r, true)
  }

  private begin(programId: string, now: number, slot: { from: number; to: number }): void {
    const to = slot.to
    // server ripartito dopo uno spegnimento improvviso dentro la stessa fascia: si continua la stessa
    // puntata, accodando l'audio allo stesso file (come quando ffmpeg riparte), invece di farne un'altra
    const old = this.d.programs.interruptedDrafts().find((x) => x.programId === programId && x.recordedFrom >= slot.from)
    const e = old ? this.d.programs.resumeRecording(old.id) : this.d.programs.startRecording(programId, now)
    const r: Running = {
      episodeId: e.id,
      programId,
      to,
      proc: null,
      out: createWriteStream(this.d.programs.rawFile(e.id), { flags: 'a' }),
      stopping: false,
      broken: false,
      restart: null
    }
    r.out.on('error', (err) => {
      if (r.broken) return
      r.broken = true
      this.fail(`registrazione di ${e.title} interrotta, il file non si scrive`, err)
      r.proc?.kill()
    })
    this.running.set(programId, r)
    this.log(`registrazione ${old ? 'ripresa' : 'avviata'}: ${e.title}`)
    this.launch(r)
    this.d.onChange?.()
  }

  private launch(r: Running): void {
    if (r.broken || r.stopping) return
    const proc = this.spawn(this.d.ffmpeg ?? 'ffmpeg', recordArgs(this.d.url, this.d.bitrate ?? '128k'))
    r.proc = proc
    // pipe e non write: se il disco è lento ffmpeg aspetta invece di riempire la memoria
    proc.stdout?.pipe(r.out, { end: false })
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
    try {
      const proc = r.proc
      if (proc) {
        const exited = new Promise<boolean>((ok) => {
          proc.on('exit', () => ok(true))
          setTimeout(() => ok(false), 3000)
        })
        proc.kill()
        // ffmpeg non si ferma: lo si chiude per forza, altrimenti resterebbe acceso per sempre
        if (!(await exited)) proc.kill('SIGKILL')
        await new Promise((ok) => setImmediate(ok))
        // da qui in poi niente più audio nel file (scrivere su un file chiuso farebbe cadere il server)
        proc.stdout?.unpipe(r.out)
      }
      await new Promise<void>((ok) => {
        if (r.out.destroyed || r.out.writableFinished) return ok()
        r.out.once('close', () => ok())
        r.out.end()
        setTimeout(ok, 5000)
      })
    } catch (err) {
      this.fail('chiusura della registrazione', err)
    }
    this.running.delete(r.programId)
    try {
      if (discard) {
        this.d.programs.removeEpisode(r.episodeId)
      } else {
        const length = await (this.d.seconds ?? mp3Seconds)(this.d.programs.rawFile(r.episodeId)).catch(() => 0)
        const e = this.d.programs.endRecording(r.episodeId, this.now(), length)
        if (e) {
          this.log(`registrazione finita: ${e.title} (${Math.round(length / 60)} minuti), da rivedere`)
          this.d.onDraft?.(e)
        } else {
          this.log('registrazione finita senza audio: scartata')
        }
      }
    } catch (err) {
      this.fail('fine della registrazione', err)
    }
    try {
      this.d.onChange?.()
    } catch (err) {
      this.fail('aggiornamento', err)
    }
  }

  /** Spegnimento: le registrazioni in corso diventano bozze. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await Promise.all([...this.running.values()].map((r) => this.finish(r)))
  }
}

/** Bozze che si stanno tagliando adesso (una volta sola per bozza). */
const publishing = new Set<string>()

/** La bozza si sta pubblicando: niente altre operazioni finché non ha finito. */
export function isPublishing(id: string): boolean {
  return publishing.has(id)
}

/**
 * Stereo Tool sulle registrazioni della regia (vedi stereotoolFile.ts): lo imposta il server all'avvio.
 * Senza, le registrazioni della regia restano bozze (non si pubblicano senza elaborazione).
 */
export interface Elaborazione {
  /** Taglia `input` tra from e to (secondi), lo passa in Stereo Tool e scrive `output`. */
  elabora: (input: string, output: string, from: number, to: number) => Promise<void>
  /** Messaggio per chi gestisce la radio (Telegram/email). */
  avvisa?: (text: string) => void
  /** Dopo la pubblicazione (o l'errore): per ridisegnare il pannello. */
  fatto?: (e: Episode | null) => void
}
let elaborazione: Elaborazione | null = null
export function configuraElaborazione(e: Elaborazione | null): void {
  elaborazione = e
}

/**
 * Taglia la bozza tra inizio e fine (secondi) e la pubblica. Le registrazioni della regia passano prima
 * in Stereo Tool: ci vogliono minuti, quindi la puntata resta "in elaborazione" e si pubblica da sola alla
 * fine (la funzione risponde subito).
 */
export async function publishEpisode(
  programs: Programs,
  id: string,
  meta: { from: number; to: number; title: string; description: string },
  opts: { ffmpeg?: string; spawn?: Spawn; seconds?: (file: string) => Promise<number> } = {}
): Promise<Episode> {
  const e = programs.episode(id)
  if (!e) throw new Error('puntata non trovata')
  if (e.status !== 'bozza') throw new Error('si possono pubblicare solo le bozze')
  if (publishing.has(id)) throw new Error('la puntata si sta già pubblicando')
  if (e.stereotool) return startProcessing(programs, e, meta, opts)
  publishing.add(id)
  try {
    return await cutAndPublish(programs, e, meta, opts)
  } finally {
    publishing.delete(id)
  }
}

function startProcessing(
  programs: Programs,
  e: Episode,
  meta: { from: number; to: number; title: string; description: string },
  opts: { seconds?: (file: string) => Promise<number> }
): Episode {
  const el = elaborazione
  if (!el) throw new Error('Stereo Tool non è disponibile sul server: la registrazione della regia non si può elaborare')
  const id = e.id
  if (!existsSync(programs.rawFile(id))) throw new Error('il file della registrazione non c\'è più')
  const from = Math.max(0, Number(meta.from) || 0)
  const to = Math.min(e.length || Infinity, Number(meta.to) || e.length)
  if (!(to - from >= 10)) throw new Error('la puntata deve durare almeno 10 secondi: controlla inizio e fine')
  publishing.add(id)
  programs.editEpisode(id, { title: meta.title, description: meta.description })
  const started = programs.patchEpisode(id, { status: 'elaborazione', cut: { from, to }, reason: undefined })
  const out = programs.episodeFile(id)
  const tmp = `${out}.tmp`
  void (async () => {
    let done: Episode | null = null
    try {
      await el.elabora(programs.rawFile(id), tmp, from, to)
      if (!programs.episode(id)) throw new Error('puntata eliminata durante l\'elaborazione')
      renameSync(tmp, out)
      const length = (await (opts.seconds ?? mp3Seconds)(out).catch(() => 0)) || Math.round(to - from)
      done = programs.published(id, { title: meta.title, description: meta.description, length })
      el.avvisa?.(`✅ Puntata pubblicata (passata in Stereo Tool): ${done.title}`)
    } catch (err) {
      rmSync(tmp, { force: true })
      const why = err instanceof Error ? err.message : String(err)
      if (programs.episode(id)) {
        programs.patchEpisode(id, { status: 'bozza', reason: `pubblicazione non riuscita: ${why}` })
        el.avvisa?.(`❌ Puntata non pubblicata (${e.title}): ${why}. È rimasta da rivedere nel pannello.`)
      }
    } finally {
      publishing.delete(id)
      el.fatto?.(done)
    }
  })()
  return started
}

async function cutAndPublish(
  programs: Programs,
  e: Episode,
  meta: { from: number; to: number; title: string; description: string },
  opts: { ffmpeg?: string; spawn?: Spawn; seconds?: (file: string) => Promise<number> }
): Promise<Episode> {
  const id = e.id
  if (!existsSync(programs.rawFile(id))) throw new Error('il file della registrazione non c\'è più')
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
  if (!programs.episode(id)) {
    // eliminata mentre si tagliava
    rmSync(tmp, { force: true })
    throw new Error('puntata non trovata')
  }
  renameSync(tmp, out)
  const length = (await (opts.seconds ?? mp3Seconds)(out).catch(() => 0)) || Math.round(to - from)
  return programs.published(id, { title: meta.title, description: meta.description, length })
}
