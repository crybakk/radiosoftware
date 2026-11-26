import { describe, expect, it } from 'vitest'
import { loadOpus, type OpusCodec } from './opus.ts'
import { Ricevitore, valutaLinea, type LineaStato } from './ricevitore.ts'

/** Codec finto: ogni pacchetto porta un numero; il "pcm" ripete quel numero (negativo se ricostruito con la FEC, 7777 se inventato). */
const finto: OpusCodec = {
  decoder: () => ({
    decode: (data, samples, fec) => new Int16Array(samples * 2).fill(data ? (fec ? -data.readInt16BE(0) : data.readInt16BE(0)) : 7777),
    samples: () => 960,
    close: () => {}
  }),
  encoder: () => ({
    encode: (pcm) => {
      const b = Buffer.alloc(2)
      b.writeInt16BE(pcm[0])
      return b
    },
    close: () => {}
  })
}

function rtp(seq: number, n: number, ssrc = 1234): Buffer {
  const b = Buffer.alloc(14)
  b[0] = 0x80
  b[1] = 111
  b.writeUInt16BE(seq & 0xffff, 2)
  b.writeUInt32BE((seq * 960) >>> 0, 4)
  b.writeUInt32BE(ssrc, 8)
  b.writeInt16BE(n, 12)
  return b
}

/** Simula: arrivi[i] = ms di arrivo del pacchetto i (null = perso). Restituisce i numeri usciti. */
function simula(arrivi: (number | null)[], opt: { codec?: OpusCodec | null; fino?: number; seqBase?: number } = {}) {
  let t = 1_000_000
  const t0 = t
  const out: number[] = []
  const linee: LineaStato[] = []
  const r = new Ricevitore({
    codec: opt.codec === undefined ? finto : opt.codec,
    send: (p) => out.push(p.length >= 14 ? p.readInt16BE(12) : NaN),
    onLinea: (s) => linee.push(s),
    now: () => t,
    timer: false
  })
  r.apri()
  const ordine = arrivi.map((a, i) => ({ a, i })).filter((x) => x.a !== null).sort((x, y) => x.a! - y.a!)
  const fine = opt.fino ?? Math.max(0, ...arrivi.map((a) => a ?? 0)) + 1500
  let k = 0
  for (let ms = 0; ms <= fine; ms += 5) {
    t = t0 + ms
    while (k < ordine.length && ordine[k].a! <= ms) {
      r.push(rtp((opt.seqBase ?? 0) + ordine[k].i, ordine[k].i + 1))
      k++
    }
    r.tick()
  }
  return { out, linee, r }
}

const regolari = (n: number, perso: number[] = []): (number | null)[] => Array.from({ length: n }, (_, i) => (perso.includes(i) ? null : i * 20))

describe('valutaLinea', () => {
  it('verde, giallo, rosso, assente con frasi semplici', () => {
    expect(valutaLinea({ perdita: 0, buchi: 0, ritardo: 60, assente: false }).livello).toBe('buona')
    expect(valutaLinea({ perdita: 10, buchi: 0, ritardo: 60, assente: false })).toMatchObject({ livello: 'debole', frase: expect.stringContaining('intero') })
    expect(valutaLinea({ perdita: 3, buchi: 2, ritardo: 60, assente: false })).toMatchObject({ livello: 'debole', frase: expect.stringContaining('salt') })
    expect(valutaLinea({ perdita: 3, buchi: 0, ritardo: 450, assente: false }).livello).toBe('debole')
    expect(valutaLinea({ perdita: 20, buchi: 6, ritardo: 60, assente: false }).livello).toBe('pessima')
    expect(valutaLinea({ perdita: 0, buchi: 0, ritardo: 900, assente: false }).livello).toBe('pessima')
    expect(valutaLinea({ perdita: 0, buchi: 0, ritardo: 0, assente: true })).toMatchObject({ livello: 'assente', frase: 'L\'audio non arriva' })
  })
})

describe('ricevitore delle voci', () => {
  it('linea perfetta: tutto in ordine, buffer piccolo, verde', () => {
    const { out, linee, r } = simula(regolari(600), { fino: 600 * 20 })
    const veri = out.filter((n) => n > 0)
    expect(veri.slice(0, 280)).toEqual(Array.from({ length: 280 }, (_, i) => i + 1))
    expect(out.filter((n) => n === 7777 || n < 0)).toEqual([])
    expect(r.target).toBeLessThanOrEqual(70)
    expect(linee[linee.length - 1].livello).toBe('buona')
  })

  it('un pacchetto perso si ricostruisce con la copia di riserva del successivo (FEC)', () => {
    const { out } = simula(regolari(100, [50]))
    const i = out.indexOf(50)
    expect(out[i + 1]).toBe(-52) // il 51 (numero 51) ricostruito dal pacchetto 52
    expect(out[i + 2]).toBe(52)
    expect(out.slice(0, i + 40)).not.toContain(7777)
  })

  it('due persi di fila: il primo inventato, il secondo dalla FEC', () => {
    const { out } = simula(regolari(100, [50, 51]))
    const i = out.indexOf(50)
    expect(out.slice(i + 1, i + 4)).toEqual([7777, -53, 53])
  })

  it('pacchetti scambiati di posto: escono in ordine, niente perso', () => {
    const a = regolari(100)
    a[40] = 41 * 20 + 3
    a[41] = 40 * 20 + 3
    const { out } = simula(a)
    expect(out.filter((n) => n > 0).slice(0, 100)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
  })

  it('linea che balla (4G): il buffer si allarga da solo e poi non salta più', () => {
    let seme = 7
    const caso = (): number => ((seme = (seme * 16807) % 2147483647) / 2147483647)
    const a = Array.from({ length: 1500 }, (_, i) => i * 20 + Math.floor(caso() * 150))
    const { out, r, linee } = simula(a, { fino: 1500 * 20 + 100 })
    expect(r.target).toBeGreaterThanOrEqual(130)
    expect(r.target).toBeLessThanOrEqual(400)
    // nell'ultima parte (buffer già adattato) nessun buco
    const ultimi = out.slice(-600, -100)
    expect(ultimi.filter((n) => n === 7777 || n < 0)).toEqual([])
    // tutti i pacchetti suonati, nessuno perso
    expect(new Set(out.filter((n) => n > 0)).size).toBeGreaterThan(1430)
    expect(linee[linee.length - 1].livello).not.toBe('pessima')
  })

  it('molte perdite: giallo o rosso, la FEC copre quasi tutto', () => {
    const persi = Array.from({ length: 600 }, (_, i) => i).filter((i) => i % 8 === 3)
    const { out, linee } = simula(regolari(600, persi), { fino: 600 * 20 })
    expect(out.filter((n) => n < 0).length).toBeGreaterThan(60)
    expect(linee[linee.length - 1]).toMatchObject({ livello: 'debole' })
    expect(linee[linee.length - 1].perdita).toBeGreaterThan(8)
  })

  it('la rete si ferma: si smette dopo poco e la linea diventa "assente"', () => {
    const { out, linee } = simula(regolari(100), { fino: 100 * 20 + 3000 })
    expect(out.filter((n) => n === 7777).length).toBeLessThanOrEqual(16)
    expect(linee[linee.length - 1].livello).toBe('assente')
  })

  it('il ritardo accumulato si recupera quando la linea torna buona', () => {
    // 2 secondi di linea pessima (ritardi fino a 400 ms), poi 20 secondi perfetti
    const a = Array.from({ length: 1100 }, (_, i) => i * 20 + (i < 100 ? (i % 10) * 40 : 0))
    const { r } = simula(a)
    expect(r.target).toBeLessThan(250)
  })

  it('microfono riaperto (flusso nuovo): riparte senza confondersi', () => {
    let t = 0
    const out: number[] = []
    const r = new Ricevitore({ codec: finto, send: (p) => out.push(p.readInt16BE(12)), now: () => t, timer: false })
    r.apri()
    for (let i = 0; i < 50; i++) {
      t = i * 20
      r.push(rtp(1000 + i, i + 1, 1))
      r.tick()
    }
    for (let i = 0; i < 50; i++) {
      t = 2000 + i * 20
      r.push(rtp(30000 + i, 100 + i, 2))
      r.tick()
    }
    for (; t < 4000; t += 5) r.tick()
    expect(out).toContain(149)
    expect(out.filter((n) => n >= 100).slice(0, 5)).toEqual([100, 101, 102, 103, 104])
  })

  it('sequenza che ricomincia da zero (65535 → 0) senza perdite', () => {
    const { out } = simula(regolari(100), { seqBase: 65500 })
    expect(out.filter((n) => n > 0).slice(0, 100)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
  })

  it('senza libopus i pacchetti passano come prima e la perdita si misura lo stesso', () => {
    const persi = Array.from({ length: 300 }, (_, i) => i).filter((i) => i % 10 === 0)
    const { out, linee } = simula(regolari(300, persi), { codec: null, fino: 300 * 20 })
    expect(out.length).toBe(270)
    expect(linee[linee.length - 1].perdita).toBeGreaterThan(8)
    expect(linee[linee.length - 1].livello).toBe('pessima')
  })
})

const opus = loadOpus()
describe.skipIf(!opus)('con il vero libopus', () => {
  it('decodifica, ricostruisce con la FEC e ricodifica', () => {
    const enc = opus!.encoder(64_000)
    const pacchetti: Buffer[] = []
    for (let f = 0; f < 50; f++) {
      const pcm = new Int16Array(1920)
      for (let i = 0; i < 960; i++) pcm[2 * i] = pcm[2 * i + 1] = Math.round(8000 * Math.sin(((f * 960 + i) * 2 * Math.PI * 440) / 48000))
      pacchetti.push(enc.encode(pcm))
    }
    let t = 0
    const out: Buffer[] = []
    const r = new Ricevitore({ codec: opus, send: (p) => out.push(p), now: () => t, timer: false })
    r.apri()
    for (let i = 0; i < 50; i++) {
      t = i * 20
      if (i !== 20) {
        const h = rtp(i, 0).subarray(0, 12)
        r.push(Buffer.concat([h, pacchetti[i]]))
      }
      r.tick()
    }
    for (; t < 2000; t += 5) r.tick()
    expect(out.length).toBeGreaterThanOrEqual(48)
    // escono pacchetti Opus validi
    const dec = opus!.decoder()
    expect(dec.samples(out[10].subarray(12))).toBe(960)
    r.chiudi()
  })
})
