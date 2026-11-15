import { describe, expect, it } from 'vitest'
import { RtpNormalizer, VOICE_PAYLOAD_TYPE } from './rtp.ts'

function pkt(seq: number, ts: number, ssrc: number, pt = 109): Buffer {
  const b = Buffer.alloc(16)
  b[0] = 0x80
  b[1] = 0x80 | pt
  b.writeUInt16BE(seq, 2)
  b.writeUInt32BE(ts, 4)
  b.writeUInt32BE(ssrc, 8)
  return b
}
const read = (b: Buffer) => ({ pt: b[1] & 0x7f, marker: b[1] >> 7, seq: b.readUInt16BE(2), ts: b.readUInt32BE(4), ssrc: b.readUInt32BE(8) })

describe('flusso RTP continuo verso Liquidsoap', () => {
  it('un secondo microfono continua il flusso del primo', () => {
    let now = 1000
    const n = new RtpNormalizer(() => now, 100)
    const a = [0, 1, 2].map((i) => read(n.map(pkt(5000 + i, 9000 + i * 960, 111))!))
    expect(a.map((x) => x.seq)).toEqual([101, 102, 103])
    expect(a[1].ts - a[0].ts).toBe(960)
    expect(a.every((x) => x.pt === VOICE_PAYLOAD_TYPE && x.marker === 1)).toBe(true)
    // 2 secondi dopo, nuovo browser con numeri del tutto diversi
    now += 2000
    const b = read(n.map(pkt(60000, 5, 222))!)
    expect(b.ssrc).toBe(a[0].ssrc)
    expect(b.seq).toBe(104)
    expect(b.ts - a[2].ts).toBe(96000)
    const c = read(n.map(pkt(60001, 965, 222))!)
    expect(c.seq).toBe(105)
    expect(c.ts - b.ts).toBe(960)
  })

  it('giro dei numeri di sequenza e pacchetti non validi', () => {
    const n = new RtpNormalizer(() => 0, 0xfffe)
    expect(read(n.map(pkt(10, 0, 1))!).seq).toBe(0xffff)
    expect(read(n.map(pkt(11, 960, 1))!).seq).toBe(0)
    expect(n.map(Buffer.alloc(4))).toBeNull()
    expect(n.map(Buffer.alloc(20))).toBeNull()
  })
})
