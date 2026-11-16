/**
 * Riconoscimento dei brani durante le dirette esterne (scelta di cristian, 15/11/2026: solo nelle esterne,
 * perché gli altri brani hanno già tutti i dati).
 *
 * - Ogni 5 secondi si prendono gli ultimi 12 secondi del programma e si cercano tra le impronte della
 *   libreria della regia e dei brani sconosciuti già etichettati.
 * - Un brano è riconosciuto quando lo stesso risultato arriva due volte di fila: va nel registro del
 *   server come "esterna", e da lì nel report SIAE della regia.
 * - Se per almeno un minuto non si riconosce nulla, si salva un brano sconosciuto: 20 secondi di audio da
 *   ascoltare e l'impronta di tutto il tratto. Dal pannello si etichetta una volta sola (oppure si scarta
 *   se era parlato) e da lì in poi viene riconosciuto.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setAsideBroken } from './statoFile.ts'
import { FpIndex, fingerprint, fingerprintWeak, fpFromBytes, fpToBytes, LIBRARY_HOP, QUERY_HOP, SAMPLE_RATE, type Match } from './impronta.ts'

const WINDOW_S = 12
const STEP_S = 5
/** Tratto minimo senza riconoscimento per salvare un brano sconosciuto. */
const UNKNOWN_MIN_S = 60
/** Oltre questa durata il tratto sconosciuto si chiude e ne inizia un altro. */
const UNKNOWN_MAX_S = 6 * 60
const CLIP_S = 20
/** Sotto questo volume (RMS) è silenzio: non si cerca e non si archivia. */
const SILENCE_RMS = 0.005

// ---------- archivio delle impronte della libreria (caricate dalla regia) ----------

export interface FpMeta {
  id: string
  title: string
  artist: string
  duration: number
}

/** Un file per brano: una riga JSON con i dati, poi l'impronta in byte. */
export class FpStore {
  readonly index = new FpIndex()
  private readonly dir: string
  private readonly meta = new Map<string, FpMeta & { n: number }>()

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.fp')) continue
      try {
        const { meta, fp } = parseFpFile(readFileSync(join(dir, f)))
        this.meta.set(meta.id, { ...meta, n: fp.length })
        this.index.put({ id: meta.id, title: meta.title, artist: meta.artist, fp })
      } catch {
        // file rovinato: la regia lo rimanda al prossimo invio
      }
    }
  }

  private file(id: string): string {
    return join(this.dir, `${createHash('sha1').update(id).digest('hex')}.fp`)
  }

  list(): { id: string; n: number }[] {
    return [...this.meta.values()].map((m) => ({ id: m.id, n: m.n }))
  }

  get(id: string): FpMeta | undefined {
    return this.meta.get(id)
  }

  put(meta: FpMeta, fp: Uint32Array): void {
    const f = this.file(meta.id)
    writeFileSync(`${f}.tmp`, buildFpFile(meta, fp))
    renameSync(`${f}.tmp`, f)
    this.meta.set(meta.id, { ...meta, n: fp.length })
    this.index.put({ id: meta.id, title: meta.title, artist: meta.artist, fp })
  }

  remove(id: string): void {
    rmSync(this.file(id), { force: true })
    this.meta.delete(id)
    this.index.remove(id)
  }
}

export function buildFpFile(meta: FpMeta, fp: Uint32Array): Uint8Array {
  const head = Buffer.from(`${JSON.stringify(meta)}\n`)
  return Buffer.concat([head, fpToBytes(fp)])
}

export function parseFpFile(b: Uint8Array): { meta: FpMeta; fp: Uint32Array } {
  const nl = b.indexOf(10)
  if (nl < 0) throw new Error('impronta non valida')
  const meta = JSON.parse(Buffer.from(b.subarray(0, nl)).toString('utf8')) as FpMeta | null
  if (!meta || typeof meta !== 'object' || !meta.id || typeof meta.id !== 'string') throw new Error('impronta senza id')
  // copia allineata a 4 byte
  const body = new Uint8Array(b.subarray(nl + 1))
  return { meta: { id: meta.id, title: String(meta.title ?? ''), artist: String(meta.artist ?? ''), duration: Number(meta.duration) || 0 }, fp: fpFromBytes(body) }
}

// ---------- brani sconosciuti ----------

export interface UnknownLabel {
  title: string
  artist: string
  composer: string
  publisher: string
}

export interface Unknown {
  /** "sconosciuto/<numero>" */
  id: string
  /** Quando è stato sentito, una voce per passaggio (ISO). */
  heard: string[]
  seconds: number
  label: UnknownLabel | null
}

/** Archivio dei brani sconosciuti: per ciascuno dati (JSON), audio di 20 secondi (MP3) e impronta. */
export class UnknownStore {
  private readonly dir: string
  private readonly index: FpIndex
  private readonly items = new Map<string, Unknown>()
  private next = 1

  constructor(dir: string, index: FpIndex) {
    this.dir = dir
    this.index = index
    mkdirSync(dir, { recursive: true })
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(f)
      if (!m) continue
      // il numero non si riusa anche se la voce è rovinata (un brano nuovo la sovrascriverebbe)
      this.next = Math.max(this.next, Number(m[1]) + 1)
      let u: Unknown
      try {
        u = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Unknown
      } catch (e) {
        // voce rovinata: si ignora, e il file si sposta da parte
        setAsideBroken(join(dir, f), e, undefined, true)
        continue
      }
      try {
        const fp = fpFromBytes(new Uint8Array(readFileSync(join(dir, `${m[1]}.fp`))))
        this.items.set(u.id, u)
        index.put({ id: u.id, title: u.label?.title ?? '', artist: u.label?.artist ?? '', fp })
      } catch {
        // impronta mancante o rovinata: si ignora
      }
    }
  }

  private num(id: string): string | null {
    const m = /^sconosciuto\/(\d+)$/.exec(id)
    return m ? m[1] : null
  }

  list(): Unknown[] {
    return [...this.items.values()].sort((a, b) => (b.heard[0] ?? '').localeCompare(a.heard[0] ?? ''))
  }

  get(id: string): Unknown | undefined {
    return this.items.get(id)
  }

  clipFile(id: string): string | null {
    const n = this.num(id)
    return n && this.items.has(id) ? join(this.dir, `${n}.mp3`) : null
  }

  /** Nuovo sconosciuto; clip = file MP3 già scritto in clipTmp (o null). */
  add(at: string, seconds: number, fp: Uint32Array, clipTmp: string | null): Unknown {
    const n = String(this.next++)
    const u: Unknown = { id: `sconosciuto/${n}`, heard: [at], seconds: Math.round(seconds), label: null }
    writeFileSync(join(this.dir, `${n}.fp`), fpToBytes(fp))
    if (clipTmp && existsSync(clipTmp)) renameSync(clipTmp, join(this.dir, `${n}.mp3`))
    this.items.set(u.id, u)
    this.save(u)
    this.index.put({ id: u.id, title: '', artist: '', fp })
    return u
  }

  heardAgain(id: string, at: string): void {
    const u = this.items.get(id)
    if (!u) return
    u.heard.push(at)
    this.save(u)
  }

  setLabel(id: string, label: UnknownLabel): Unknown {
    const u = this.items.get(id)
    if (!u) throw new Error('brano sconosciuto non trovato')
    if (!label.title.trim() || !label.artist.trim()) throw new Error('servono almeno titolo e interprete')
    u.label = {
      title: label.title.trim().slice(0, 300),
      artist: label.artist.trim().slice(0, 300),
      composer: label.composer.trim().slice(0, 500),
      publisher: label.publisher.trim().slice(0, 300)
    }
    this.save(u)
    const n = this.num(id)!
    this.index.put({ id, title: u.label.title, artist: u.label.artist, fp: fpFromBytes(new Uint8Array(readFileSync(join(this.dir, `${n}.fp`)))) })
    return u
  }

  /** Scarta (per esempio era parlato): via dati, audio e impronta. */
  discard(id: string): void {
    const n = this.num(id)
    if (!n || !this.items.has(id)) throw new Error('brano sconosciuto non trovato')
    for (const ext of ['json', 'mp3', 'fp']) rmSync(join(this.dir, `${n}.${ext}`), { force: true })
    this.items.delete(id)
    this.index.remove(id)
  }

  private save(u: Unknown): void {
    const n = this.num(u.id)!
    const f = join(this.dir, `${n}.json`)
    writeFileSync(`${f}.tmp`, JSON.stringify(u))
    renameSync(`${f}.tmp`, f)
  }
}

// ---------- riconoscimento in tempo reale ----------

export interface Recognized extends Match {
  /** Inizio stimato del brano (ISO). */
  at: string
}

/** Audio di qualità per i clip da ascoltare: mono, 4 volte la frequenza delle impronte. */
export const CLIP_RATE = SAMPLE_RATE * 4

export interface RecognizerHooks {
  search: (q: Uint32Array, weak: Uint32Array) => Match | null
  onPlay: (r: Recognized) => void
  /**
   * Tratto non riconosciuto: audio del clip (mono, CLIP_RATE se arriva da pushClip, altrimenti 5512 Hz),
   * impronta del tratto, inizio, durata in secondi.
   */
  onUnknown: (clip: { pcm: Float32Array; rate: number }, fp: Uint32Array, at: string, seconds: number) => void
  now?: () => number
}

function rms(a: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * a[i]
  return Math.sqrt(s / Math.max(1, a.length))
}

export class Recognizer {
  private readonly win = WINDOW_S * SAMPLE_RATE
  private readonly step = STEP_S * SAMPLE_RATE
  private buf = new Float32Array(WINDOW_S * SAMPLE_RATE)
  private filled = 0
  private sinceStep = 0
  private pending: string | null = null
  private current: string | null = null
  /** Ultimo passaggio registrato per brano (ms), per non contarlo due volte. */
  private lastLogged = new Map<string, number>()
  private unknown: Float32Array[] = []
  private unknownLen = 0
  private unknownStart = 0
  private readonly hooks: RecognizerHooks
  private readonly now: () => number
  /** Ultimi minuti di audio di qualità (anello) e quanti campioni sono arrivati in tutto. */
  private hq = new Float32Array((UNKNOWN_MAX_S + 30) * CLIP_RATE)
  private hqTotal = 0
  private lqTotal = 0

  constructor(hooks: RecognizerHooks) {
    this.hooks = hooks
    this.now = hooks.now ?? (() => Date.now())
  }

  /** Audio di qualità (mono, CLIP_RATE) per i clip; facoltativo, va in parallelo a push(). */
  pushClip(samples: Float32Array): void {
    const n = this.hq.length
    for (let i = 0; i < samples.length; i++) this.hq[(this.hqTotal + i) % n] = samples[i]
    this.hqTotal += samples.length
  }

  /** Audio mono a 5512 Hz, a pezzi di qualunque lunghezza. */
  push(samples: Float32Array): void {
    let i = 0
    while (i < samples.length) {
      const n = Math.min(samples.length - i, this.step - this.sinceStep)
      const chunk = samples.subarray(i, i + n)
      // finestra scorrevole degli ultimi 12 secondi
      if (n >= this.win) this.buf.set(chunk.subarray(n - this.win))
      else {
        this.buf.copyWithin(0, n)
        this.buf.set(chunk, this.win - n)
      }
      this.filled = Math.min(this.win, this.filled + n)
      this.sinceStep += n
      this.lqTotal += n
      i += n
      if (this.sinceStep >= this.step) {
        this.sinceStep = 0
        if (this.filled >= this.win) this.analyze()
      }
    }
  }

  /** Fine della diretta esterna: chiude il tratto sconosciuto in corso. */
  end(): void {
    this.closeUnknown()
    this.hqTotal = 0
    this.lqTotal = 0
    this.filled = 0
    this.sinceStep = 0
    this.pending = null
    this.current = null
  }

  private analyze(): void {
    const now = this.now()
    const latest = this.buf.slice(this.win - this.step)
    if (rms(this.buf) < SILENCE_RMS) {
      this.pending = null
      this.current = null
      this.closeUnknown()
      return
    }
    const { fp, weak } = fingerprintWeak(this.buf, QUERY_HOP)
    const m = this.hooks.search(fp, weak)
    if (!m) {
      this.pending = null
      this.current = null
      if (!this.unknownLen) {
        // il tratto sconosciuto parte dall'inizio della finestra
        this.unknownStart = now - WINDOW_S * 1000
        this.unknown.push(this.buf.slice(0, this.win - this.step))
        this.unknownLen += this.win - this.step
      }
      this.unknown.push(latest)
      this.unknownLen += latest.length
      if (this.unknownLen >= UNKNOWN_MAX_S * SAMPLE_RATE) this.closeUnknown()
      return
    }
    this.closeUnknown()
    if (m.id === this.current) return
    if (m.id !== this.pending) {
      this.pending = m.id
      return
    }
    // stesso risultato due volte di fila: riconosciuto
    this.current = m.id
    this.pending = null
    const start = now - (WINDOW_S + Math.max(0, m.offset)) * 1000
    const last = this.lastLogged.get(m.id)
    if (last != null && Math.abs(start - last) < 60_000) return
    this.lastLogged.set(m.id, start)
    this.hooks.onPlay({ ...m, at: new Date(start).toISOString() })
  }

  private closeUnknown(): void {
    const len = this.unknownLen
    const parts = this.unknown
    this.unknown = []
    this.unknownLen = 0
    if (len < UNKNOWN_MIN_S * SAMPLE_RATE) return
    const all = new Float32Array(len)
    let o = 0
    for (const p of parts) {
      all.set(p, o)
      o += p.length
    }
    // 20 secondi dal centro del tratto (di solito il pezzo più riconoscibile)
    const c = Math.max(0, Math.floor(len / 2 - (CLIP_S * SAMPLE_RATE) / 2))
    let clip = { pcm: all.slice(c, c + CLIP_S * SAMPLE_RATE), rate: SAMPLE_RATE }
    // stesso tratto dall'audio di qualità, se c'è: il tratto finisce al campione lqTotal (meno quello non analizzato)
    const endLq = this.lqTotal - this.sinceStep
    const fromHq = (endLq - len + c) * 4
    const k = CLIP_S * CLIP_RATE
    if (this.hqTotal > 0 && fromHq >= this.hqTotal - this.hq.length && fromHq + k <= this.hqTotal) {
      const pcm = new Float32Array(k)
      for (let i = 0; i < k; i++) pcm[i] = this.hq[(fromHq + i) % this.hq.length]
      clip = { pcm, rate: CLIP_RATE }
    }
    this.hooks.onUnknown(clip, fingerprint(all, LIBRARY_HOP), new Date(this.unknownStart).toISOString(), len / SAMPLE_RATE)
  }
}
