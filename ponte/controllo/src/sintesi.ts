/**
 * Voce sintetica per gli annunci (usata sia dalla regia sia dal server).
 *
 * Usa sherpa-onnx con le voci italiane di Piper: gratuito e senza internet (internet serve solo la prima
 * volta, per scaricare la voce scelta, circa 30-65 MB). Il Piper "ufficiale" del 2023 non apre più le voci
 * pubblicate di recente, sherpa-onnx sì.
 *
 * Il testo lo scrive l'utente, con delle parti che si riempiono da sole ({ora}, {brano}, ...).
 * Il risultato è un MP3 con le impostazioni già applicate (velocità, espressività, pause, tono, volume).
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { cleanVoice, sentences, voiceUrl, VOICES, type VoiceInfo, type VoiceSettings } from './annunci.ts'

export * from './annunci.ts'

/** Filtro ffmpeg per tono e volume, più un attimo di silenzio prima e dopo. */
export function voiceFilter(v: VoiceSettings, sampleRate: number): string {
  const f: string[] = []
  if (v.pitch) {
    // cambia il tono senza cambiare la durata: si "accelera" e poi si riporta alla velocità giusta
    const k = 2 ** (v.pitch / 12)
    f.push(`asetrate=${Math.round(sampleRate * k)}`, `aresample=${sampleRate}`, `atempo=${(1 / k).toFixed(4)}`)
  }
  if (v.volumeDb) f.push(`volume=${v.volumeDb}dB`)
  f.push('adelay=200:all=1', 'apad=pad_dur=0.4')
  return f.join(',')
}

// ---------- motore ----------

/** Il pezzo di sherpa-onnx che serve (sostituibile nei test). */
export interface TtsEngine {
  sampleRate: number
  generate(text: string, speed: number): Promise<Float32Array>
}

export type EngineFactory = (dir: string, id: string, v: VoiceSettings) => Promise<TtsEngine>

/** Motore vero: sherpa-onnx-node, caricato solo quando serve. */
export const sherpaEngine: EngineFactory = async (dir, id, v) => {
  const req = createRequire(import.meta.url)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sherpa = req('sherpa-onnx-node') as any
  const tts = new sherpa.OfflineTts({
    model: {
      vits: {
        model: join(dir, `${id}.onnx`),
        tokens: join(dir, 'tokens.txt'),
        dataDir: join(dir, 'espeak-ng-data'),
        noiseScale: v.expressiveness,
        noiseScaleW: v.rhythm,
        lengthScale: 1
      },
      numThreads: 2,
      provider: 'cpu',
      debug: false
    },
    maxNumSentences: 1
  })
  return {
    sampleRate: tts.sampleRate as number,
    // enableExternalBuffer: false perché Electron non accetta la memoria esterna dei moduli nativi
    generate: async (text, speed) => {
      const a = (await tts.generateAsync({ text, sid: 0, speed, enableExternalBuffer: false })) as { samples: Float32Array }
      return a.samples
    }
  }
}

export type Spawn = (cmd: string, args: string[]) => ChildProcess

const run = (spawn: Spawn, cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    let err = ''
    p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').at(-1) || `uscito con codice ${code}`))))
  })

/** WAV mono a 16 bit da campioni float. */
export function wav(samples: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + samples.length * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return b
}

export interface SynthDeps {
  /** Cartella delle voci scaricate. */
  voicesDir: string
  /** Cartella dei file prodotti (si tengono gli ultimi 200). */
  outDir: string
  ffmpeg: string
  engine?: EngineFactory
  spawn?: Spawn
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

/** Scarica le voci e produce gli MP3 degli annunci. */
export class Synth {
  private readonly d: SynthDeps
  private readonly engine: EngineFactory
  private readonly spawn: Spawn
  private readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  private readonly downloading = new Map<string, Promise<void>>()
  private readonly engines = new Map<string, Promise<TtsEngine>>()

  constructor(d: SynthDeps) {
    this.d = d
    this.engine = d.engine ?? sherpaEngine
    this.spawn = d.spawn ?? ((c, a) => nodeSpawn(c, a, { windowsHide: true }))
    this.fetch = d.fetch ?? fetch
  }

  private voiceDir(id: string): string {
    return join(this.d.voicesDir, `vits-piper-${id}`)
  }

  hasVoice(id: string): boolean {
    const dir = this.voiceDir(id)
    return existsSync(join(dir, `${id}.onnx`)) && existsSync(join(dir, 'tokens.txt')) && existsSync(join(dir, 'espeak-ng-data'))
  }

  /** Voci con lo stato (scaricata, in scaricamento). */
  voices(): (VoiceInfo & { installed: boolean; downloading: boolean })[] {
    return VOICES.map((v) => ({ ...v, installed: this.hasVoice(v.id), downloading: this.downloading.has(v.id) }))
  }

  /** Scarica una voce (la prima volta). */
  installVoice(id: string): Promise<void> {
    if (this.hasVoice(id)) return Promise.resolve()
    let p = this.downloading.get(id)
    if (!p) {
      p = (async () => {
        const url = voiceUrl(id)
        await mkdir(this.d.voicesDir, { recursive: true })
        const archive = join(this.d.voicesDir, `${id}.tar.bz2`)
        try {
          const r = await this.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20 * 60_000) })
          if (!r.ok) throw new Error(`scaricamento della voce non riuscito (${r.status})`)
          const buf = Buffer.from(await r.arrayBuffer())
          if (!buf.length) throw new Error('scaricamento della voce vuoto')
          await writeFile(archive, buf)
          // tar c'è sia su Linux sia su Windows 10/11
          await run(this.spawn, 'tar', ['-xjf', archive, '-C', this.d.voicesDir])
        } finally {
          await rm(archive, { force: true })
        }
        if (!this.hasVoice(id)) throw new Error('voce non trovata dopo lo scaricamento')
      })().finally(() => this.downloading.delete(id))
      this.downloading.set(id, p)
    }
    return p
  }

  /** Toglie una voce scaricata (per liberare spazio). */
  async removeVoice(id: string): Promise<void> {
    if (!VOICES.some((v) => v.id === id)) throw new Error('voce sconosciuta')
    for (const k of [...this.engines.keys()]) if (k.startsWith(`${id}|`)) this.engines.delete(k)
    await rm(this.voiceDir(id), { recursive: true, force: true })
  }

  private getEngine(v: VoiceSettings): Promise<TtsEngine> {
    const key = `${v.voice}|${v.expressiveness}|${v.rhythm}`
    let e = this.engines.get(key)
    if (!e) {
      // si tengono pronte al massimo 3 combinazioni (ognuna occupa memoria)
      if (this.engines.size >= 3) this.engines.delete(this.engines.keys().next().value!)
      e = this.engine(this.voiceDir(v.voice), v.voice, v)
      e.catch(() => this.engines.delete(key))
      this.engines.set(key, e)
    }
    return e
  }

  /**
   * Produce l'MP3 dell'annuncio. Lo stesso testo con le stesse impostazioni non si rifà: si riusa il file.
   * Se la voce non c'è ancora la scarica (serve internet solo quella volta).
   */
  async speak(text: string, settings: Partial<VoiceSettings>): Promise<{ file: string; seconds: number }> {
    const v = cleanVoice(settings)
    const parts = sentences(text)
    if (!parts.length) throw new Error('testo vuoto')
    if (text.length > 3000) throw new Error('testo troppo lungo (massimo 3000 caratteri)')
    await mkdir(this.d.outDir, { recursive: true })
    const key = createHash('sha1').update(JSON.stringify([parts, v])).digest('hex').slice(0, 16)
    const mp3 = join(this.d.outDir, `annuncio-${key}.mp3`)
    if (!existsSync(mp3)) {
      await this.installVoice(v.voice)
      const engine = await this.getEngine(v)
      const pause = new Float32Array(Math.round(v.sentencePause * engine.sampleRate))
      const chunks: Float32Array[] = []
      for (const [i, s] of parts.entries()) {
        if (i) chunks.push(pause)
        chunks.push(await engine.generate(s, v.speed))
      }
      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        all.set(c, at)
        at += c.length
      }
      const wavFile = join(this.d.outDir, `annuncio-${key}.wav`)
      const tmp = join(this.d.outDir, `annuncio-${key}.tmp.mp3`)
      try {
        await writeFile(wavFile, wav(all, engine.sampleRate))
        await run(this.spawn, this.d.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavFile, '-af', voiceFilter(v, engine.sampleRate), '-ar', '44100', '-ac', '1', '-b:a', '128k', tmp])
        await rename(tmp, mp3)
      } finally {
        await rm(wavFile, { force: true })
        await rm(tmp, { force: true })
      }
      this.prune()
    }
    // MP3 a 128 kbit/s costanti: la durata viene dalla dimensione
    return { file: mp3, seconds: Math.max(1, Math.round((statSync(mp3).size * 8) / 128_000)) }
  }

  /** Tiene solo gli ultimi 200 annunci prodotti. */
  private prune(): void {
    try {
      const files = readdirSync(this.d.outDir)
        .filter((f) => /^annuncio-[0-9a-f]+\.mp3$/.test(f))
        .map((f) => ({ f, t: statSync(join(this.d.outDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      for (const x of files.slice(200)) void rm(join(this.d.outDir, x.f), { force: true })
    } catch {
      // niente
    }
  }
}
