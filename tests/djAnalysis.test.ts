import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  analyzeDjSignal,
  camelot,
  chooseDownbeat,
  energyScore,
  findSections,
  fitGrid,
  foldBpm,
  trackBeats,
  keysCompatible,
  type EssentiaLike
} from '../src/core/djAnalysis'
import { RadioDb, type ScannedFile } from '../src/core/db'
import { DJ_ANALYSIS_VERSION } from '../src/core/djAnalysis'

describe('griglia dei battiti', () => {
  it('trova BPM e primo battito anche con battiti arrotondati ai fotogrammi e in ritardo accumulato', () => {
    // 124 BPM, battiti arrotondati a 11,6 ms come fa Essentia: il passo "medio" tra due battiti inganna
    const period = 60 / 124
    const hop = 512 / 44100
    const ticks = Array.from({ length: 380 }, (_, i) => Math.round((1.3 + i * period) / hop) * hop)
    const g = fitGrid(ticks, 1, 200)
    expect(g.bpm).toBeCloseTo(124, 1)
    expect(Math.abs(g.firstBeat - 1.3)).toBeLessThan(0.02)
    expect(g.confidence).toBeGreaterThan(0.95)
  })

  it('battiti a caso: griglia non affidabile', () => {
    let x = 0
    const ticks = Array.from({ length: 200 }, (_, i) => (x += 0.3 + ((i * 7919) % 13) / 20))
    expect(fitGrid(ticks, 0, 1000).confidence).toBeLessThan(0.6)
  })

  it('pochi battiti: niente griglia', () => {
    expect(fitGrid([1, 1.5, 2], 0, 10).bpm).toBe(0)
  })
})

describe('battiti seguiti uno a uno', () => {
  /** Brano suonato senza metronomo: da 128 a 128,4 BPM in 4 minuti, battiti arrotondati ai fotogrammi di Essentia. */
  function driftingTicks(): { truth: number[]; ticks: number[] } {
    const hop = 512 / 44100
    const truth: number[] = []
    for (let t = 0.3; t < 240; ) {
      truth.push(t)
      t += 60 / (128 * (1 + 0.003 * (t / 240)))
    }
    // i primi battiti di Essentia sono sbagliati ("riscaldamento")
    const ticks = truth.map((t, i) => Math.round((t + (i < 4 ? 0.06 - i * 0.015 : 0)) / hop) * hop)
    return { truth, ticks }
  }

  it('la griglia fissa sbaglia di quasi un decimo alla fine; quella seguita resta entro pochi millesimi', () => {
    const { truth, ticks } = driftingTicks()
    const grid = fitGrid(ticks, 0, 240)
    const fixedErr = (t: number): number => {
      const p = 60 / grid.bpm
      return Math.abs(grid.firstBeat + Math.round((t - grid.firstBeat) / p) * p - t)
    }
    expect(fixedErr(truth.at(-1)!)).toBeGreaterThan(0.05)
    const tr = trackBeats(ticks, grid, 0, 240)
    expect(tr.confidence).toBeGreaterThan(0.95)
    expect(tr.beats.length).toBe(truth.length)
    const errs = tr.beats.map((b, i) => Math.abs(b - truth[i]))
    expect(Math.max(...errs)).toBeLessThan(0.012)
  })

  it('un battito trovato male non sposta la griglia', () => {
    const { truth, ticks } = driftingTicks()
    ticks[200] += 0.04
    ticks.splice(300, 1)
    const tr = trackBeats(ticks, fitGrid(ticks, 0, 240), 0, 240)
    expect(Math.abs(tr.beats[200] - truth[200])).toBeLessThan(0.012)
    expect(Math.abs(tr.beats[300] - truth[300])).toBeLessThan(0.012)
  })
})

describe('primo tempo della battuta', () => {
  it('è dove cambiano gli accordi', () => {
    const novelty = Array.from({ length: 64 }, (_, i) => (i % 4 === 2 ? 1 : 0.1))
    const bass = Array.from({ length: 64 }, () => 1)
    expect(chooseDownbeat(novelty, bass)).toBe(2)
  })
})

describe('intro e outro', () => {
  it('cadono su una frase di 8 battute', () => {
    // 8 battute calme, 32 piene, 8 calme
    const bars = [...Array(8).fill(0.2), ...Array(32).fill(1), ...Array(8).fill(0.3)]
    const s = findSections(bars, 2, 2, 2 + 48 * 2)
    expect(s.introEnd).toBeCloseTo(2 + 8 * 2, 3)
    expect(s.outroStart).toBeCloseTo(2 + 40 * 2, 3)
  })

  it('un brano che parte e finisce pieno non ha intro né outro', () => {
    const bars = Array(40).fill(1)
    const s = findSections(bars, 0.5, 2, 80.5)
    expect(s.introEnd).toBeCloseTo(0.5, 3)
    expect(s.outroStart).toBeCloseTo(80.5, 3)
  })
})

describe('tonalità ed energia', () => {
  it('notazione Camelot', () => {
    expect(camelot('A', 'minor')).toBe('8A')
    expect(camelot('C', 'major')).toBe('8B')
    expect(camelot('F#', 'major')).toBe('2B')
    expect(camelot('Eb', 'minor')).toBe('2A')
    expect(camelot('H', 'major')).toBe('')
  })

  it('tonalità compatibili: uguali, vicine o relative', () => {
    expect(keysCompatible('8A', '8A')).toBe(true)
    expect(keysCompatible('8A', '9A')).toBe(true)
    expect(keysCompatible('12A', '1A')).toBe(true)
    expect(keysCompatible('8A', '8B')).toBe(true)
    expect(keysCompatible('8A', '10A')).toBe(false)
    expect(keysCompatible('8A', '9B')).toBe(false)
    expect(keysCompatible('', '9B')).toBe(true)
  })

  it('energia da 1 a 10', () => {
    expect(energyScore(0.5, 70, 0.2)).toBeLessThanOrEqual(3)
    expect(energyScore(2.5, 128, 0.9)).toBeGreaterThanOrEqual(8)
    expect(foldBpm(160)).toBe(80)
    expect(foldBpm(60)).toBe(120)
  })
})

/** Brano finto: 8 battute di sola cassa, 32 con accordi e bassi, 8 di sola cassa. */
function syntheticSong(bpm = 124, lead = 1.3): { signal: Float32Array; introEnd: number; outroStart: number } {
  const sr = 44100
  const beat = 60 / bpm
  const bars = 48
  const n = Math.floor((lead + bars * 4 * beat + 1.5) * sr)
  const y = new Float32Array(n)
  const chords = [
    [220, 261.63, 329.63],
    [174.61, 220, 261.63],
    [261.63, 329.63, 392],
    [196, 246.94, 293.66]
  ]
  let seed = 1
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  for (let b = 0; b < bars * 4; b++) {
    const s = Math.floor((lead + b * beat) * sr)
    for (let i = 0; i < 0.25 * sr && s + i < n; i++) {
      const t = i / sr
      y[s + i] += 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-30 * t)) * t) * Math.exp(-12 * t)
    }
    const h = Math.floor((lead + (b + 0.5) * beat) * sr)
    for (let i = 0; i < 0.05 * sr && h + i < n; i++) y[h + i] += 0.2 * rnd() * Math.exp((-80 * i) / sr)
    const bar = Math.floor(b / 4)
    if (bar >= 8 && bar < 40 && b % 4 === 0) {
      const c = chords[bar % 4]
      const len = Math.floor(4 * beat * sr)
      for (let i = 0; i < len && s + i < n; i++) {
        const t = i / sr
        let v = 0
        for (const f of c) v += Math.sin(2 * Math.PI * f * t)
        y[s + i] += v * 0.12 * Math.exp(-0.3 * t) + 0.3 * Math.sin(2 * Math.PI * (c[0] / 4) * t)
      }
    }
  }
  let max = 0
  for (const v of y) max = Math.max(max, Math.abs(v))
  for (let i = 0; i < n; i++) y[i] /= max * 1.1
  return { signal: y, introEnd: lead + 8 * 4 * beat, outroStart: lead + 40 * 4 * beat }
}

describe('analisi con Essentia', () => {
  it('trova BPM, primo "uno", intro e outro di un brano finto', () => {
    const require = createRequire(import.meta.url)
    const { Essentia, EssentiaWASM } = require('essentia.js') as { Essentia: new (w: unknown) => EssentiaLike; EssentiaWASM: unknown }
    const e = new Essentia(EssentiaWASM)
    const song = syntheticSong()
    const r = analyzeDjSignal(e, song.signal, 44100, 1.2, song.signal.length / 44100 - 1)
    expect(r.bpm).toBeCloseTo(124, 0)
    expect(r.gridConfidence).toBeGreaterThan(0.9)
    expect(Math.abs(r.firstDownbeat - 1.3)).toBeLessThan(0.03)
    expect(Math.abs(r.introEnd - song.introEnd)).toBeLessThan(0.1)
    expect(Math.abs(r.outroStart - song.outroStart)).toBeLessThan(0.1)
    expect(r.energy).toBeGreaterThanOrEqual(1)
    expect(r.energy).toBeLessThanOrEqual(10)
  }, 60_000)
})

describe('database', () => {
  const file = (p: Partial<ScannedFile> = {}): ScannedFile => ({
    path: '/m/a.mp3', kind: 'music', size: 1, mtime: 1, title: 'T', artist: 'A', album: '', year: null, genre: '',
    composer: '', publisher: '', isrc: '', duration: 200, bitrate: 320, sampleRate: 44100, ...p
  })

  it('salva l\'analisi DJ e la rifà quando il file cambia', () => {
    const db = new RadioDb(':memory:')
    const id = db.upsertScanned(file())
    expect(db.pendingDj()).toHaveLength(0) // prima serve l'analisi di inizio e fine
    db.saveAnalysis(id, { duration: 200, loudness: -14, cueIn: 0.5, cueOut: 199, mixPoint: 195 })
    expect(db.pendingDj().map((t) => t.id)).toEqual([id])
    const dj = { bpm: 124, firstDownbeat: 1.3, gridConfidence: 0.98, key: '8A', energy: 7, introEnd: 16.8, outroStart: 180, downbeats: [1.3, 3.235, 5.171] }
    db.saveDj(id, dj)
    expect(db.getTrack(id)!.dj).toEqual(dj)
    expect(db.pendingDj()).toHaveLength(0)
    expect(db.djStats()).toEqual({ done: 1, total: 1 })
    db.upsertScanned(file({ mtime: 2 }))
    expect(db.getTrack(id)!.dj).toBeNull()
    db.close()
  })

  it('le analisi fatte con la versione precedente si rifanno, dopo i brani mai analizzati e prima quelli mixabili', () => {
    const db = new RadioDb(':memory:')
    const ids = ['/m/a.mp3', '/m/b.mp3', '/m/c.mp3'].map((path) => {
      const id = db.upsertScanned(file({ path }))
      db.saveAnalysis(id, { duration: 200, loudness: -14, cueIn: 0.5, cueOut: 199, mixPoint: 195 })
      return id
    })
    db.saveDj(ids[0], { bpm: 0, firstDownbeat: 0, gridConfidence: 0.2, key: '', energy: 3, introEnd: 0, outroStart: 199 })
    db.saveDj(ids[1], { bpm: 124, firstDownbeat: 1, gridConfidence: 0.9, key: '8A', energy: 7, introEnd: 16, outroStart: 180 })
    // come le avrebbe lasciate la versione precedente
    db.db.exec('UPDATE tracks SET dj_ver = 0')
    expect(db.pendingDj().map((t) => t.id)).toEqual([ids[2], ids[1], ids[0]])
    expect(db.djStats()).toEqual({ done: 0, total: 3 })
    // nel frattempo vale la griglia vecchia
    expect(db.getTrack(ids[1])!.dj?.bpm).toBe(124)
    db.saveDj(ids[1], { bpm: 124, firstDownbeat: 1, gridConfidence: 0.9, key: '8A', energy: 7, introEnd: 16, outroStart: 180 })
    expect(db.pendingDj().map((t) => t.id)).toEqual([ids[2], ids[0]])
    expect(DJ_ANALYSIS_VERSION).toBeGreaterThan(1)
    db.close()
  })

  it('un file non analizzabile resta senza griglia e non si riprova', () => {
    const db = new RadioDb(':memory:')
    const id = db.upsertScanned(file())
    db.saveAnalysis(id, { duration: 200, loudness: -14, cueIn: 0.5, cueOut: 199, mixPoint: 195 })
    db.saveDj(id, null)
    expect(db.getTrack(id)!.dj?.bpm).toBe(0)
    expect(db.pendingDj()).toHaveLength(0)
    db.close()
  })
})
