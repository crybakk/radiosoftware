/**
 * Impronte audio per riconoscere i brani in onda (solo durante le dirette esterne).
 *
 * Non serve nessun servizio esterno: le impronte si confrontano solo con quelle della nostra libreria
 * (calcolate dalla regia e caricate sul server) e dei brani sconosciuti etichettati dal pannello.
 * Lo stesso codice gira sulla regia (Electron) e sul ponte (Node), così le impronte sono identiche.
 *
 * Metodo (tipo Haitsma-Kalker): audio mono a 5512 Hz, finestre di 2048 campioni, 33 bande
 * logaritmiche tra 300 e 2000 Hz; ogni finestra dà un numero a 32 bit con il segno della differenza
 * di energia tra bande vicine, rispetto alla stessa differenza 1024 campioni prima.
 * La libreria si salva con un passo di 1024 campioni (circa 5 numeri al secondo, 20 KB per 4 minuti),
 * l'audio da riconoscere si calcola con un passo di 256: così c'è sempre una finestra quasi allineata.
 */

export const SAMPLE_RATE = 5512
const FRAME = 2048
/** Distanza tra le due finestre confrontate per ogni bit (fissa, indipendente dal passo). */
const DELTA = 1024
export const LIBRARY_HOP = 1024
export const QUERY_HOP = 256
const BANDS = 33
const F_MIN = 300
const F_MAX = 2000

/** Parole chiave dell'indice: i 20 bit più alti dell'impronta. */
const KEY_BITS = 20
/** Sotto questa percentuale di bit diversi due tratti sono lo stesso brano (a caso è circa il 50%). */
export const MAX_BER = 0.35
/** Finestre della libreria da confrontare almeno (circa 6 secondi). */
const MIN_COMPARED = 32

// ---------- calcolo ----------

const hann = (() => {
  const w = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))
  return w
})()

/** Confini delle bande in indici della FFT. */
const bandEdges = (() => {
  const e = new Int32Array(BANDS + 1)
  for (let b = 0; b <= BANDS; b++) {
    const f = F_MIN * Math.pow(F_MAX / F_MIN, b / BANDS)
    e[b] = Math.round((f * FRAME) / SAMPLE_RATE)
  }
  return e
})()

const bitrev = (() => {
  const bits = Math.log2(FRAME)
  const r = new Uint32Array(FRAME)
  for (let i = 0; i < FRAME; i++) {
    let x = i
    let y = 0
    for (let b = 0; b < bits; b++) {
      y = (y << 1) | (x & 1)
      x >>= 1
    }
    r[i] = y
  }
  return r
})()

const twiddle = (() => {
  const c = new Float64Array(FRAME / 2)
  const s = new Float64Array(FRAME / 2)
  for (let i = 0; i < FRAME / 2; i++) {
    c[i] = Math.cos((-2 * Math.PI * i) / FRAME)
    s[i] = Math.sin((-2 * Math.PI * i) / FRAME)
  }
  return { c, s }
})()

/** Energia delle 33 bande della finestra che inizia in pos. */
function bandEnergy(pcm: Float32Array, pos: number, re: Float64Array, im: Float64Array, out: Float64Array): void {
  for (let i = 0; i < FRAME; i++) {
    re[bitrev[i]] = pcm[pos + i] * hann[i]
    im[bitrev[i]] = 0
  }
  for (let size = 2; size <= FRAME; size <<= 1) {
    const half = size >> 1
    const step = FRAME / size
    for (let start = 0; start < FRAME; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = twiddle.c[k * step]
        const wi = twiddle.s[k * step]
        const a = start + k
        const b = a + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
  for (let band = 0; band < BANDS; band++) {
    let e = 0
    for (let k = bandEdges[band]; k < bandEdges[band + 1]; k++) e += re[k] * re[k] + im[k] * im[k]
    out[band] = e
  }
}

/**
 * Impronta di un audio mono a 5512 Hz. Il valore i descrive la finestra che inizia a
 * DELTA + i * hop campioni dall'inizio.
 */
export function fingerprint(pcm: Float32Array, hop: number): Uint32Array {
  return fingerprintWeak(pcm, hop).fp
}

/** Bit meno sicuri tra quelli della chiave, provati anche invertiti nella ricerca. */
const WEAK_BITS = 3

/**
 * Impronta più, per ogni finestra, la maschera dei 3 bit della chiave meno sicuri (differenza più vicina
 * a zero): sono quelli che il rumore cambia più facilmente.
 */
export function fingerprintWeak(pcm: Float32Array, hop: number): { fp: Uint32Array; weak: Uint32Array } {
  if (DELTA % hop !== 0) throw new Error('passo non valido')
  const back = DELTA / hop
  const n = Math.max(0, Math.floor((pcm.length - FRAME - DELTA) / hop) + 1)
  const out = new Uint32Array(n)
  const weak = new Uint32Array(n)
  const mag = new Float64Array(KEY_BITS)
  const re = new Float64Array(FRAME)
  const im = new Float64Array(FRAME)
  // energie delle finestre a partire da 0, con lo stesso passo: la finestra "prima" è back posizioni indietro
  const total = n + back
  const energy = new Float64Array(total * BANDS)
  const tmp = new Float64Array(BANDS)
  for (let w = 0; w < total; w++) {
    bandEnergy(pcm, w * hop, re, im, tmp)
    energy.set(tmp, w * BANDS)
  }
  for (let i = 0; i < n; i++) {
    const c = (i + back) * BANDS
    const p = i * BANDS
    let v = 0
    for (let m = 0; m < 32; m++) {
      const d = energy[c + m] - energy[c + m + 1] - (energy[p + m] - energy[p + m + 1])
      if (d > 0) v |= 1 << (31 - m)
      if (m < KEY_BITS) mag[m] = Math.abs(d)
    }
    out[i] = v >>> 0
    let mask = 0
    for (let k = 0; k < WEAK_BITS; k++) {
      let best = -1
      for (let m = 0; m < KEY_BITS; m++) if (!(mask & (1 << (31 - m))) && (best < 0 || mag[m] < mag[best])) best = m
      mask |= 1 << (31 - best)
    }
    weak[i] = mask >>> 0
  }
  return { fp: out, weak }
}

/** PCM s16le (come lo dà ffmpeg con -f s16le) → float. */
export function s16ToFloat(buf: Uint8Array): Float32Array {
  const n = buf.length >> 1
  const dv = new DataView(buf.buffer, buf.byteOffset, n * 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768
  return out
}

/** Argomenti di ffmpeg per avere l'audio nel formato delle impronte. */
export function ffmpegDecodeArgs(input: string, maxSeconds?: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', input,
    ...(maxSeconds ? ['-t', String(maxSeconds)] : []),
    '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'
  ]
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

// ---------- archivio e ricerca ----------

export interface FpEntry {
  id: string
  title: string
  artist: string
  /** Impronta con passo LIBRARY_HOP. */
  fp: Uint32Array
}

export interface Match {
  id: string
  title: string
  artist: string
  /** Secondi dall'inizio del brano a cui corrisponde l'inizio dell'audio cercato. */
  offset: number
  /** Percentuale di bit diversi (più bassa = più sicuro). */
  ber: number
}

/**
 * Indice in memoria: per ogni chiave (20 bit) l'elenco di (brano, finestra).
 * Si ricostruisce quando cambiano le impronte: 20.000 brani sono circa 26 milioni di voci, 200 MB.
 */
export class FpIndex {
  private entries: FpEntry[] = []
  private starts: Uint32Array = new Uint32Array((1 << KEY_BITS) + 1)
  private postings: Uint32Array = new Uint32Array(0)
  private dirty = true
  private byId = new Map<string, number>()

  get size(): number {
    return this.byId.size
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  ids(): { id: string; n: number }[] {
    return this.entries.filter(Boolean).map((e) => ({ id: e.id, n: e.fp.length }))
  }

  put(e: FpEntry): void {
    const i = this.byId.get(e.id)
    if (i != null) this.entries[i] = e
    else {
      this.byId.set(e.id, this.entries.length)
      this.entries.push(e)
    }
    this.dirty = true
  }

  remove(id: string): void {
    const i = this.byId.get(id)
    if (i == null) return
    this.entries[i] = { id, title: '', artist: '', fp: new Uint32Array(0) }
    this.byId.delete(id)
    this.dirty = true
  }

  private build(): void {
    if (this.entries.length >= 1 << 16) throw new Error('troppe impronte per l\'indice')
    const count = new Uint32Array((1 << KEY_BITS) + 1)
    let total = 0
    for (const e of this.entries) {
      for (let f = 0; f < e.fp.length && f < 1 << 16; f++) count[(e.fp[f] >>> (32 - KEY_BITS)) + 1]++
      total += Math.min(e.fp.length, 1 << 16)
    }
    for (let k = 1; k < count.length; k++) count[k] += count[k - 1]
    const starts = count.slice()
    const fill = count.slice()
    const postings = new Uint32Array(total)
    this.entries.forEach((e, t) => {
      for (let f = 0; f < e.fp.length && f < 1 << 16; f++) postings[fill[e.fp[f] >>> (32 - KEY_BITS)]++] = ((t << 16) | f) >>> 0
    })
    this.starts = starts
    this.postings = postings
    this.dirty = false
  }

  /**
   * Cerca un tratto di audio (impronta con passo QUERY_HOP, di solito 10-15 secondi).
   * null = nessun brano conosciuto.
   */
  search(q: Uint32Array, weak?: Uint32Array): Match | null {
    if (this.dirty) this.build()
    const ratio = LIBRARY_HOP / QUERY_HOP
    // voti per (brano, allineamento): allineamento = finestra della libreria * ratio - finestra cercata
    const votes = new Map<number, number>()
    const flips: number[] = []
    for (let j = 0; j < q.length; j++) {
      // chiave così com'è e con i bit meno sicuri invertiti (tutte le combinazioni)
      flips.length = 0
      flips.push(0)
      if (weak) {
        for (let b = 0; b < 32; b++) {
          const bit = (weak[j] >>> b) & 1
          if (!bit) continue
          const n = flips.length
          for (let x = 0; x < n; x++) flips.push((flips[x] | (1 << b)) >>> 0)
        }
      }
      for (const flip of flips) {
      const k = (q[j] ^ flip) >>> (32 - KEY_BITS)
      for (let p = this.starts[k]; p < this.starts[k + 1]; p++) {
        const v = this.postings[p]
        const t = v >>> 16
        const f = v & 0xffff
        const align = f * ratio - j
        const key = t * 1_000_000 + (align + 500_000)
        votes.set(key, (votes.get(key) ?? 0) + 1)
      }
      }
    }
    const cands = [...votes.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20)
    let best: Match | null = null
    for (const [key] of cands) {
      const t = Math.floor(key / 1_000_000)
      const align = (key % 1_000_000) - 500_000
      const e = this.entries[t]
      const ber = compare(e.fp, q, align, ratio)
      if (ber == null || ber > MAX_BER) continue
      if (!best || ber < best.ber) {
        best = { id: e.id, title: e.title, artist: e.artist, offset: (align * QUERY_HOP) / SAMPLE_RATE, ber }
      }
    }
    return best
  }
}

/** Bit diversi tra la libreria e il tratto cercato, con l'allineamento dato. */
function compare(lib: Uint32Array, q: Uint32Array, align: number, ratio: number): number | null {
  let diff = 0
  let n = 0
  // finestre della libreria f con f*ratio - align dentro il tratto cercato
  const first = Math.max(0, Math.ceil(align / ratio))
  for (let f = first; f < lib.length; f++) {
    const j = f * ratio - align
    if (j >= q.length) break
    diff += popcount((lib[f] ^ q[j]) >>> 0)
    n++
  }
  if (n < MIN_COMPARED) return null
  return diff / (n * 32)
}

// ---------- formato dei file ----------

/** Impronta in byte (little endian), per salvarla o mandarla al ponte. */
export function fpToBytes(fp: Uint32Array): Uint8Array {
  const out = new Uint8Array(fp.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < fp.length; i++) dv.setUint32(i * 4, fp[i], true)
  return out
}

export function fpFromBytes(b: Uint8Array): Uint32Array {
  const n = b.length >> 2
  const dv = new DataView(b.buffer, b.byteOffset, n * 4)
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) out[i] = dv.getUint32(i * 4, true)
  return out
}
