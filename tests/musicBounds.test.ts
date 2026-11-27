import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeFile } from '../src/core/analyzer'
import { BOUNDS_SAMPLE_RATE as SR, boundsFromKinds, findMusicBounds, type BlockKind } from '../src/core/musicBounds'

// generatore pseudo-casuale fisso: le prove danno sempre lo stesso risultato
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** "Canzone": cassa a tempo (120 BPM), basso e accordi che cambiano ogni 2 secondi, charleston. */
function music(seconds: number, level = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  const r = rng(1)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const f = 1 + (Math.floor(t / 2) % 4) / 4
    const beat = t % 0.5
    const kick = 0.9 * Math.exp(-30 * beat) * Math.sin(2 * Math.PI * 60 * beat * (1 + 3 * Math.exp(-20 * beat)))
    const chord = 0.15 * (Math.sin(2 * Math.PI * 220 * f * t) + Math.sin(2 * Math.PI * 277 * f * t) + Math.sin(2 * Math.PI * 330 * f * t))
    const bass = 0.3 * Math.sin(2 * Math.PI * 55 * f * t)
    const hat = 0.1 * (r() - 0.5) * Math.exp(-60 * ((t + 0.25) % 0.5))
    out[i] = level * (kick + chord + bass + hat)
  }
  return out
}

/** "Parlato": sillabe di lunghezza e altezza variabili, con la voce che sale e scende, e pause irregolari. */
function speech(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  const r = rng(7)
  let i = 0
  while (i < out.length) {
    const len = Math.round((0.08 + 0.18 * r()) * SR)
    const f0 = 100 + 80 * r()
    const glide = (r() - 0.5) * 200
    const formant = 500 + 1500 * r()
    const noisy = r() < 0.25
    for (let k = 0; k < len && i + k < out.length; k++) {
      const t = k / SR
      const env = Math.sin((Math.PI * k) / len)
      const f = f0 + glide * t
      let v = 0
      if (noisy) v = 0.3 * (r() - 0.5)
      else for (let h = 1; h <= 8; h++) v += (Math.sin(2 * Math.PI * f * h * t) / h) * Math.exp(-Math.abs(f * h - formant) / 800)
      out[i + k] = 0.25 * env * v
    }
    i += len + Math.round((0.03 + (r() < 0.2 ? 0.35 : 0.08) * r()) * SR)
  }
  return out
}

/** "Applausi": rumore che va e viene. */
function applause(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  const r = rng(3)
  for (let i = 0; i < out.length; i++) out[i] = 0.15 * (r() - 0.5) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 7 * i) / SR))
  return out
}

/** Intro dolce: note di pianoforte che si spengono piano, una ogni secondo e mezzo. */
function piano(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const f = 262 + 60 * (Math.floor(t / 1.5) % 5)
    out[i] = 0.3 * Math.exp(-1.5 * (t % 1.5)) * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t))
  }
  return out
}

/** Intro di sola batteria: colpi con silenzio in mezzo, ma a tempo. */
function drums(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  const r = rng(5)
  for (let i = 0; i < out.length; i++) {
    const beat = (i / SR) % 0.5
    out[i] = 0.9 * Math.exp(-30 * beat) * Math.sin(2 * Math.PI * 60 * beat * (1 + 3 * Math.exp(-20 * beat))) + 0.4 * (r() - 0.5) * Math.exp(-80 * ((i / SR + 0.25) % 0.5))
  }
  return out
}

const silence = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * SR))

function join2(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const bounds = (s: Float32Array): ReturnType<typeof findMusicBounds> => findMusicBounds(s, SR, 0, s.length / SR)

describe('taglio delle parti non musicali', () => {
  it('una canzone normale resta intera', () => {
    expect(bounds(music(150))).toMatchObject({ start: 0, end: 150, cutStart: null, cutEnd: null })
  })

  it('toglie la presentazione parlata all\'inizio e gli applausi alla fine', () => {
    const b = bounds(join2(speech(14), music(150), applause(15)))
    expect(b.cutStart).toBe('speech')
    expect(b.start).toBeGreaterThanOrEqual(12.5)
    expect(b.start).toBeLessThanOrEqual(14)
    expect(b.cutEnd).toBe('noise')
    expect(b.end).toBeGreaterThanOrEqual(164)
    expect(b.end).toBeLessThanOrEqual(165.5)
  })

  it('toglie applausi e parlato messi insieme (live)', () => {
    const b = bounds(join2(applause(10), speech(10), music(150), speech(10), applause(10)))
    expect(b.start).toBeGreaterThanOrEqual(19)
    expect(b.start).toBeLessThanOrEqual(20)
    expect(b.end).toBeGreaterThanOrEqual(170)
    expect(b.end).toBeLessThanOrEqual(171.5)
  })

  it('non tocca le intro musicali calme o di sola batteria', () => {
    for (const intro of [piano(20), drums(16)]) {
      const b = bounds(join2(intro, music(150)))
      expect(b.start).toBe(0)
      expect(b.cutStart).toBeNull()
    }
  })

  it('una canzone tutta "spoglia" non viene scambiata per parlato', () => {
    // un brano fatto tutto di note sparse: il corpo del brano è così, non c'è niente da tagliare
    expect(bounds(piano(150))).toMatchObject({ start: 0, end: 150 })
  })

  it('toglie la traccia fantasma dopo un lungo silenzio', () => {
    const b = bounds(join2(music(150), silence(30), music(60)))
    expect(b.cutEnd).toBe('hidden')
    expect(b.end).toBeGreaterThanOrEqual(150)
    expect(b.end).toBeLessThanOrEqual(151)
  })

  it('una pausa breve in mezzo alla canzone non la taglia', () => {
    const b = bounds(join2(music(100), silence(3), music(100)))
    expect(b.end).toBe(203)
  })

  it('non taglia parti non musicali troppo lunghe (meglio lasciare che sbagliare)', () => {
    const kinds: BlockKind[] = [...Array<BlockKind>(60).fill('speech'), ...Array<BlockKind>(150).fill('music')]
    expect(boundsFromKinds(kinds, null, 0, 210)).toMatchObject({ start: 0, cutStart: null })
    const ok: BlockKind[] = [...Array<BlockKind>(30).fill('speech'), ...Array<BlockKind>(150).fill('music')]
    expect(boundsFromKinds(ok, null, 0, 180)).toMatchObject({ start: 29.5, cutStart: 'speech' })
  })

  it('il silenzio puro si taglia anche se lungo', () => {
    const kinds: BlockKind[] = [...Array<BlockKind>(70).fill('silence'), ...Array<BlockKind>(150).fill('music')]
    expect(boundsFromKinds(kinds, null, 0, 220).cutStart).toBe('silence')
  })

  it('analisi di un file vero: i punti di inizio e fine saltano parlato e applausi', async () => {
    let hasFfmpeg = true
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    } catch {
      hasFfmpeg = false
    }
    if (!hasFfmpeg) return
    const dir = mkdtempSync(join(tmpdir(), 'taglio-'))
    try {
      const pcm = join2(speech(12), music(140), applause(12))
      writeFileSync(join(dir, 'a.raw'), Buffer.from(pcm.buffer))
      const file = join(dir, 'live.mp3')
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', join(dir, 'a.raw'), '-ar', '44100', '-ac', '2', '-b:a', '192k', file])
      const r = await analyzeFile('ffmpeg', file, undefined, 60_000, true)
      expect(r.cueIn).toBeGreaterThanOrEqual(10.5)
      expect(r.cueIn).toBeLessThanOrEqual(12.2)
      expect(r.cueOut).toBeGreaterThanOrEqual(151.5)
      expect(r.cueOut).toBeLessThanOrEqual(153.5)
      expect(r.mixPoint).toBeLessThanOrEqual(r.cueOut)
      // i jingle e i notiziari non si toccano: solo il silenzio
      const plain = await analyzeFile('ffmpeg', file, undefined, 60_000, false)
      expect(plain.cueIn).toBeLessThan(1)
      expect(plain.cueOut).toBeGreaterThan(163)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
