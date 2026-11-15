/**
 * Rende continuo il flusso RTP della voce verso Liquidsoap.
 *
 * Ogni volta che un conduttore apre il microfono il browser inizia un flusso nuovo
 * (altro SSRC, numeri di sequenza e tempi casuali). Il lettore RTP di Liquidsoap
 * scarterebbe il secondo flusso come "pacchetti vecchi": qui riscriviamo SSRC,
 * tipo di carico, sequenza e tempo in modo che per Liquidsoap sia sempre lo stesso flusso.
 */

export const VOICE_PAYLOAD_TYPE = 111
const CLOCK_RATE = 48_000

export class RtpNormalizer {
  private readonly ssrc: number
  private inSsrc: number | null = null
  private seqOffset = 0
  private tsOffset = 0
  private lastOutSeq: number
  private lastOutTs: number
  private lastWall = 0

  private readonly now: () => number

  constructor(now: () => number = () => Date.now(), seed = Math.floor(Math.random() * 0xffff)) {
    this.now = now
    this.ssrc = 0x52414449 // "RADI"
    this.lastOutSeq = seed & 0xffff
    this.lastOutTs = (seed * 7919) >>> 0
  }

  /** Restituisce il pacchetto riscritto, o null se non è un pacchetto RTP valido. */
  map(pkt: Buffer): Buffer | null {
    if (pkt.length < 12 || pkt[0] >> 6 !== 2) return null
    const out = Buffer.from(pkt)
    const inSeq = out.readUInt16BE(2)
    const inTs = out.readUInt32BE(4)
    const inSsrc = out.readUInt32BE(8)
    const wall = this.now()
    if (inSsrc !== this.inSsrc) {
      // flusso nuovo: continua da dove era rimasto il precedente, con il tempo trascorso nel mezzo
      const gap = this.lastWall ? Math.max(20, wall - this.lastWall) : 20
      const nextSeq = (this.lastOutSeq + 1) & 0xffff
      const nextTs = (this.lastOutTs + Math.round((gap * CLOCK_RATE) / 1000)) >>> 0
      this.seqOffset = (nextSeq - inSeq) & 0xffff
      this.tsOffset = (nextTs - inTs) >>> 0
      this.inSsrc = inSsrc
    }
    const seq = (inSeq + this.seqOffset) & 0xffff
    const ts = (inTs + this.tsOffset) >>> 0
    out[1] = (out[1] & 0x80) | VOICE_PAYLOAD_TYPE
    out.writeUInt16BE(seq, 2)
    out.writeUInt32BE(ts, 4)
    out.writeUInt32BE(this.ssrc, 8)
    // tiene l'ultimo pacchetto "più avanti" (i pacchetti possono arrivare in disordine)
    if (((seq - this.lastOutSeq) & 0xffff) < 0x8000) {
      this.lastOutSeq = seq
      this.lastOutTs = ts
    }
    this.lastWall = wall
    return out
  }
}
