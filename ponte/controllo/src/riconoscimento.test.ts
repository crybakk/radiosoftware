import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FpIndex, fingerprint, LIBRARY_HOP, QUERY_HOP, SAMPLE_RATE, fpToBytes, fpFromBytes } from './impronta.ts'
import { FpStore, Recognizer, UnknownStore, buildFpFile, parseFpFile, type Recognized } from './riconoscimento.ts'

const SR = SAMPLE_RATE
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
}
/** "Brano" sintetico: melodia, basso e colpi di rumore, diverso per ogni seme. */
function song(seed: number, secs: number): Float32Array {
  const r = rng(seed)
  const n = SR * secs
  const out = new Float32Array(n)
  const beat = (60 / (80 + r() * 80)) * SR
  const scale = [0, 2, 4, 5, 7, 9, 11]
  const root = 48 + Math.floor(r() * 12)
  const notes = Array.from({ length: 64 }, () => root + 12 + scale[Math.floor(r() * 7)] + (r() < 0.3 ? 12 : 0))
  const bass = Array.from({ length: 16 }, () => root + scale[Math.floor(r() * 7)] - 12)
  const nr = rng(seed + 1)
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / beat)
    const ph = (i % beat) / beat
    const f = 440 * 2 ** ((notes[b % 64] - 69) / 12)
    const fb = 440 * 2 ** ((bass[Math.floor(b / 2) % 16] - 69) / 12)
    const t = i / SR
    let s = 0.3 * Math.exp(-3 * ph) * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t))
    s += 0.25 * Math.sin(2 * Math.PI * fb * t)
    if (b % 2 === 1 && ph < 0.1) s += 0.3 * (nr() * 2 - 1) * (1 - ph * 10)
    out[i] = s * 0.6
  }
  return out
}
function noisy(a: Float32Array, level: number, seed: number): Float32Array {
  const r = rng(seed)
  return a.map((x) => x * 0.8 + (r() * 2 - 1) * level)
}

const library = [1, 2, 3, 4, 5].map((s) => ({ id: `regia/b${s}.mp3`, pcm: song(s * 11, 120) }))
const index = new FpIndex()
for (const b of library) index.put({ id: b.id, title: `Titolo ${b.id}`, artist: 'X', fp: fingerprint(b.pcm, LIBRARY_HOP) })

describe('impronte', () => {
  it('ritrova un tratto di 12 secondi con rumore e il punto del brano', () => {
    const q = noisy(library[2].pcm.slice(SR * 50, SR * 62), 0.02, 7)
    const m = index.search(fingerprint(q, QUERY_HOP))
    expect(m?.id).toBe('regia/b3.mp3')
    expect(m!.offset).toBeCloseTo(50, 0)
    expect(m!.ber).toBeLessThan(0.25)
  })

  it('non inventa: un brano che non c\'è non viene riconosciuto', () => {
    for (let s = 100; s < 105; s++) expect(index.search(fingerprint(song(s, 12), QUERY_HOP))).toBeNull()
  })

  it('formato dei file', () => {
    const fp = new Uint32Array([1, 0xffffffff, 12345])
    expect([...fpFromBytes(fpToBytes(fp))]).toEqual([...fp])
    const f = parseFpFile(buildFpFile({ id: 'regia/a.mp3', title: 'A', artist: 'B', duration: 3 }, fp))
    expect(f.meta.id).toBe('regia/a.mp3')
    expect([...f.fp]).toEqual([...fp])
  })
})

describe('riconoscimento nelle esterne', () => {
  it('riconosce i brani, salva gli sconosciuti, poi li riconosce una volta etichettati', () => {
    let now = Date.parse('2026-11-15T20:00:00Z')
    const plays: Recognized[] = []
    const unknowns: { clip: { pcm: Float32Array; rate: number }; seconds: number }[] = []
    const dir = mkdtempSync(join(tmpdir(), 'ric-'))
    const store = new FpStore(join(dir, 'impronte'))
    for (const b of library.slice(0, 3)) store.put({ id: b.id, title: 'T', artist: 'A', duration: 120 }, fingerprint(b.pcm, LIBRARY_HOP))
    const unk = new UnknownStore(join(dir, 'sconosciuti'), store.index)
    const rec = new Recognizer({
      search: (q, w) => store.index.search(q, w),
      onPlay: (r) => plays.push(r),
      onUnknown: (clip, fp, at, seconds) => {
        unknowns.push({ clip, seconds })
        unk.add(at, seconds, fp, null)
      },
      now: () => now
    })
    const feed = (pcm: Float32Array): void => {
      for (let i = 0; i < pcm.length; i += SR) {
        const part = pcm.subarray(i, i + SR)
        rec.push(part)
        // audio di qualità in parallelo (qui semplicemente ripetuto 4 volte)
        rec.pushClip(Float32Array.from({ length: part.length * 4 }, (_, k) => part[k >> 2]))
        now += (part.length / SR) * 1000
      }
    }
    feed(noisy(library[1].pcm.slice(SR * 20, SR * 60), 0.02, 1))
    const sconosciuto = song(777, 90)
    feed(noisy(sconosciuto, 0.02, 2))
    feed(noisy(library[0].pcm.slice(0, SR * 40), 0.02, 3))
    rec.end()

    expect(plays.map((p) => p.id)).toEqual(['regia/b2.mp3', 'regia/b1.mp3'])
    // il primo brano era partito 20 secondi prima dell'inizio della diretta
    expect(Math.abs(Date.parse(plays[0].at) - Date.parse('2026-11-15T19:59:40Z'))).toBeLessThan(2000)
    expect(unknowns).toHaveLength(1)
    expect(unknowns[0].seconds).toBeGreaterThanOrEqual(60)
    expect(unknowns[0].clip.rate).toBe(SR * 4)
    expect(unknowns[0].clip.pcm.length).toBe(20 * SR * 4)

    // etichettato dal pannello: la volta dopo si riconosce
    const u = unk.list()[0]
    unk.setLabel(u.id, { title: 'Nuovo', artist: 'Band', composer: 'Autore', publisher: '' })
    plays.length = 0
    feed(noisy(sconosciuto.slice(SR * 30, SR * 60), 0.02, 4))
    expect(plays[0]).toMatchObject({ id: u.id, title: 'Nuovo', artist: 'Band' })

    // ricaricato dal disco
    const again = new FpStore(join(dir, 'impronte'))
    const unk2 = new UnknownStore(join(dir, 'sconosciuti'), again.index)
    expect(again.list()).toHaveLength(3)
    expect(unk2.get(u.id)?.label?.title).toBe('Nuovo')
    unk2.discard(u.id)
    expect(unk2.list()).toHaveLength(0)
  })
})
