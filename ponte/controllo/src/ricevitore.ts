/**
 * Ricevitore delle voci in WebRTC (microfono del pannello, ospiti, app Radio Esterna) — scelte di cristian del
 * 26/11/2026: linea robusta sul 4G debole, tutto automatico ("a prova di anziano": nessuna regolazione da fare).
 *
 * I pacchetti Opus arrivano dalla rete in disordine, in ritardo o mancanti. Qui:
 *   - si mettono in fila in un buffer che si allarga da solo quando la linea balla e si stringe piano
 *     quando torna buona (buffer adattivo, da 40 ms a 1 secondo);
 *   - un pacchetto perso si ricostruisce con la copia di riserva che Opus mette nel pacchetto dopo (FEC),
 *     o, se manca anche quella, con la ricostruzione di Opus (PLC);
 *   - l'audio esce con il passo regolare del server e si ricodifica in alta qualità verso Liquidsoap
 *     (sulla rete interna, dove non si perde niente);
 *   - si misura la linea, per l'indicatore verde/giallo/rosso.
 * Senza libopus (non dovrebbe succedere: arriva con ffmpeg) i pacchetti passano come prima, e la linea si misura
 * lo stesso.
 */
import { CHANNELS, type OpusCodec, type OpusDecoder, type OpusEncoder } from './opus.ts'
import type { LineaStato, LivelloLinea } from './protocol.ts'
import { RtpNormalizer, VOICE_PAYLOAD_TYPE } from './rtp.ts'

export type { LineaStato, LivelloLinea }

export interface MisuraLinea {
  perdita: number
  buchi: number
  ritardo: number
  assente: boolean
}

/** Da numeri a colore e frase. Pura, provata nei test. */
export function valutaLinea(m: MisuraLinea): LineaStato {
  const base = { perdita: Math.round(m.perdita * 10) / 10, buchi: Math.round(m.buchi * 10) / 10, ritardo: Math.round(m.ritardo) }
  if (m.assente) return { ...base, livello: 'assente', frase: 'L\'audio non arriva' }
  if (m.buchi >= 5 || m.ritardo >= 800) return { ...base, livello: 'pessima', frase: 'Linea molto debole: l\'audio salta' }
  if (m.buchi >= 1) return { ...base, livello: 'debole', frase: 'Linea debole: qualche piccolo salto nell\'audio' }
  if (m.perdita >= 8 || m.ritardo >= 400) return { ...base, livello: 'debole', frase: 'Linea debole: per ora l\'audio arriva intero' }
  return { ...base, livello: 'buona', frase: 'Linea buona' }
}

export interface RicevitoreOpzioni {
  /** null = libopus mancante: i pacchetti passano così come arrivano. */
  codec: OpusCodec | null
  /** Pacchetto RTP verso Liquidsoap. */
  send(pkt: Buffer): void
  /** La linea ha cambiato colore. */
  onLinea?(s: LineaStato): void
  now?: () => number
  /** false nei test: il passo si dà a mano con tick(). */
  timer?: boolean
  bitrate?: number
}

const FRAME = 960 // 20 ms a 48 kHz, quello che esce verso Liquidsoap
const FRAME_MS = 20
const MIN_MS = 40
const MAX_MS = 1000
/** Senza pacchetti per così tanto si smette di inventare audio e si riparte dal buffer pieno. */
const STOP_MS = 300
/** Senza pacchetti per così tanto la linea è "assente". */
const ASSENTE_MS = 2000
const FINESTRA_JITTER_MS = 10_000
const SECONDI_STATISTICA = 5
const SSRC_USCITA = 0x52414449 // "RADI", come rtp.ts

interface Pkt {
  data: Buffer
  ts: number
}

interface Secondo {
  at: number
  ricevuti: number
  attesi: number
  fec: number
  plc: number
  vuoti: number
  tardi: number
  usciti: number
}

const nuovoSecondo = (at: number): Secondo => ({ at, ricevuti: 0, attesi: 0, fec: 0, plc: 0, vuoti: 0, tardi: 0, usciti: 0 })

/** Differenza con segno tra due numeri a 16 bit (sequenza RTP). */
const diff16 = (a: number, b: number): number => ((((a - b) & 0xffff) + 0x8000) & 0xffff) - 0x8000
/** Differenza con segno tra due numeri a 32 bit (tempo RTP). */
const diff32 = (a: number, b: number): number => ((a - b) | 0)

export class Ricevitore {
  private readonly o: RicevitoreOpzioni
  private readonly now: () => number
  private readonly codec: OpusCodec | null
  private dec: OpusDecoder | null = null
  private enc: OpusEncoder | null = null
  private readonly passa = new RtpNormalizer()

  // --- ingresso ---
  private ssrc: number | null = null
  private hi = -1 // sequenza estesa più alta arrivata
  private hiTs = 0 // tempo esteso del pacchetto più alto
  private hiTsRaw = 0
  private readonly pkts = new Map<number, Pkt>()
  private next = -1 // prossimo pacchetto da suonare
  private ultimoArrivo = 0
  private campioniPacchetto = FRAME
  private jitter: { at: number; rel: number }[] = []
  private ricalcolo = 0
  target = 120

  // --- uscita ---
  private playing = false
  private clock = 0
  private usciti = 0
  private fifo: Int16Array[] = []
  private fifoLen = 0
  private vuotoDa = 0
  private troppoDa = 0
  private outSeq = Math.floor(Math.random() * 0xffff)
  private outTs = Math.floor(Math.random() * 0xffffffff) >>> 0
  private ultimoInvio = 0
  private timer: ReturnType<typeof setInterval> | null = null

  // --- misure ---
  private secondi: Secondo[] = []
  private livello: LivelloLinea | null = null
  private aperto = false
  private ultimaMisura = 0

  constructor(o: RicevitoreOpzioni) {
    this.o = o
    this.now = o.now ?? (() => Date.now())
    this.codec = o.codec
  }

  /** Nuova sessione (microfono aperto): si ricomincia a misurare. */
  apri(): void {
    this.aperto = true
    this.secondi = []
    this.livello = null
    this.ultimaMisura = 0
    this.ultimoArrivo = this.now()
    if (this.o.timer !== false && !this.timer) {
      this.timer = setInterval(() => this.tick(), 5)
      this.timer.unref?.()
    }
  }

  /** Sessione chiusa: niente più indicatore. */
  chiudi(): void {
    this.aperto = false
    this.ferma()
    this.pkts.clear()
    this.ssrc = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.dec?.close()
    this.enc?.close()
    this.dec = null
    this.enc = null
  }

  /** Pacchetto RTP dal browser o dall'app. */
  push(pkt: Buffer): void {
    if (pkt.length < 13 || pkt[0] >> 6 !== 2) return
    const t = this.now()
    const s = this.secondo(t)
    const cc = pkt[0] & 0x0f
    let off = 12 + 4 * cc
    if (pkt[0] & 0x10) {
      if (pkt.length < off + 4) return
      off += 4 + 4 * pkt.readUInt16BE(off + 2)
    }
    let end = pkt.length
    if (pkt[0] & 0x20) end -= pkt[pkt.length - 1]
    if (end <= off) return
    const seq = pkt.readUInt16BE(2)
    const ts = pkt.readUInt32BE(4)
    const ssrc = pkt.readUInt32BE(8)
    if (ssrc !== this.ssrc) {
      // flusso nuovo (microfono riaperto): si riparte da zero
      this.ssrc = ssrc
      this.pkts.clear()
      this.hi = seq
      this.hiTs = ts
      this.hiTsRaw = ts
      this.next = -1
      this.jitter = []
      this.ferma()
    }
    const ext = this.hi + diff16(seq, this.hi & 0xffff)
    const extTs = this.hiTs + diff32(ts, this.hiTsRaw)
    if (ext > this.hi) {
      s.attesi += ext - this.hi
      this.hi = ext
      this.hiTs = extTs
      this.hiTsRaw = ts
    }
    this.ultimoArrivo = t
    s.ricevuti++
    this.jitter.push({ at: t, rel: t - extTs / 48 })

    if (!this.codec) {
      // senza libopus: come prima
      const out = this.passa.map(pkt)
      if (out) this.o.send(out)
      return
    }
    if (this.playing && ext < this.next) {
      s.tardi++
      return
    }
    if (this.pkts.has(ext)) return
    this.pkts.set(ext, { data: Buffer.from(pkt.subarray(off, end)), ts: extTs })
    // un buffer enorme vuol dire un flusso impazzito: si tiene solo l'ultimo secondo e mezzo
    if (this.pkts.size > 150) {
      const min = Math.min(...this.pkts.keys())
      this.pkts.delete(min)
      if (this.next <= min) this.next = min + 1
    }
  }

  /** Passo dell'orologio: fa uscire i pezzi da 20 ms che sono dovuti. */
  tick(): void {
    const t = this.now()
    this.adatta(t)
    this.misura(t)
    if (!this.codec) return
    if (!this.playing) {
      if (!this.pkts.size) return
      const keys = [...this.pkts.keys()]
      const lo = Math.min(...keys)
      const span = (this.hi - lo + 1) * (this.campioniPacchetto / 48)
      if (span < this.target && t - this.ultimoArrivo < STOP_MS) return
      if (!this.dec) {
        try {
          this.dec = this.codec.decoder()
          this.enc = this.codec.encoder(this.o.bitrate ?? 256_000)
        } catch {
          return
        }
      }
      this.next = lo
      this.playing = true
      this.clock = t
      this.usciti = 0
      this.vuotoDa = 0
      this.troppoDa = 0
    }
    // processo rimasto fermo (server occupato): non si recupera tutto in un colpo
    if (t - (this.clock + this.usciti * FRAME_MS) > 200) {
      this.clock = t - this.usciti * FRAME_MS
    }
    while (this.playing && t - this.clock >= this.usciti * FRAME_MS) {
      this.usciti++
      this.pezzo(t)
    }
  }

  /** Un pezzo da 20 ms verso Liquidsoap. */
  private pezzo(t: number): void {
    const s = this.secondo(t)
    while (this.fifoLen < FRAME) {
      if (!this.prendi(t, s)) {
        this.ferma()
        return
      }
    }
    const out = new Int16Array(FRAME * CHANNELS)
    let i = 0
    while (i < out.length) {
      const c = this.fifo[0]
      const n = Math.min(c.length, out.length - i)
      out.set(c.subarray(0, n), i)
      i += n
      if (n === c.length) this.fifo.shift()
      else this.fifo[0] = c.subarray(n)
    }
    this.fifoLen -= FRAME
    s.usciti++
    const payload = this.enc!.encode(out)
    if (!payload.length) return
    const h = Buffer.alloc(12)
    h[0] = 0x80
    h[1] = VOICE_PAYLOAD_TYPE
    // dopo una pausa il tempo RTP fa un salto pari al tempo passato (come rtp.ts)
    if (this.ultimoInvio && t - this.ultimoInvio > 100) this.outTs = (this.outTs + Math.round((t - this.ultimoInvio) * 48) - FRAME) >>> 0
    this.outSeq = (this.outSeq + 1) & 0xffff
    this.outTs = (this.outTs + FRAME) >>> 0
    h.writeUInt16BE(this.outSeq, 2)
    h.writeUInt32BE(this.outTs, 4)
    h.writeUInt32BE(SSRC_USCITA, 8)
    this.ultimoInvio = t
    this.o.send(Buffer.concat([h, payload]))
  }

  /** Mette in fila l'audio del prossimo pacchetto (vero, ricostruito o inventato). false = basta, si riparte. */
  private prendi(t: number, s: Secondo): boolean {
    const dec = this.dec!
    const p = this.pkts.get(this.next)
    if (p) {
      this.pkts.delete(this.next)
      this.next++
      this.vuotoDa = 0
      const n = dec.samples(p.data) || this.campioniPacchetto
      this.campioniPacchetto = n
      const pcm = dec.decode(p.data, n)
      // troppo ritardo accumulato (la linea è tornata buona): si salta un pezzo, meglio se silenzioso
      if (this.troppo(t) && (silenzioso(pcm) || t - this.troppoDa > 3000)) {
        this.troppoDa = t
        return true
      }
      this.metti(pcm)
      return true
    }
    if (this.hi > this.next && this.pkts.size) {
      // perso: si ricostruisce con la copia di riserva del pacchetto dopo, se c'è
      const q = this.pkts.get(this.next + 1)
      this.next++
      if (q) {
        s.fec++
        this.metti(dec.decode(q.data, this.campioniPacchetto, true))
      } else {
        s.plc++
        this.metti(dec.decode(null, this.campioniPacchetto))
      }
      return true
    }
    // non è arrivato ancora niente: la rete è in ritardo. Si allunga l'audio (senza saltare niente)
    // e il buffer cresce da solo.
    if (!this.vuotoDa) {
      // una volta per buco: il buffer cresce subito un poco, poi ci pensa la misura del jitter
      this.vuotoDa = t
      this.target = Math.min(MAX_MS, this.target + FRAME_MS)
    }
    if (t - this.vuotoDa > STOP_MS) return false
    s.vuoti++
    this.metti(dec.decode(null, this.campioniPacchetto))
    return true
  }

  private metti(pcm: Int16Array): void {
    if (!pcm.length) return
    this.fifo.push(pcm)
    this.fifoLen += pcm.length / CHANNELS
  }

  /** In fila c'è più audio di quanto serve, da almeno un secondo. */
  private troppo(t: number): boolean {
    const inFila = this.pkts.size * (this.campioniPacchetto / 48)
    if (inFila <= this.target + 80) {
      this.troppoDa = 0
      return false
    }
    if (!this.troppoDa) {
      this.troppoDa = t
      return false
    }
    return t - this.troppoDa > 1000
  }

  private ferma(): void {
    this.playing = false
    this.fifo = []
    this.fifoLen = 0
    this.vuotoDa = 0
  }

  /** Buffer giusto per la linea: il 95% dei pacchetti deve arrivare in tempo. Su presto, giù piano. */
  private adatta(t: number): void {
    if (t - this.ricalcolo < 1000) return
    this.ricalcolo = t
    while (this.jitter.length && t - this.jitter[0].at > FINESTRA_JITTER_MS) this.jitter.shift()
    if (this.jitter.length < 20) return
    let base = Infinity
    for (const j of this.jitter) base = Math.min(base, j.rel)
    const d = this.jitter.map((j) => j.rel - base).sort((a, b) => a - b)
    const p95 = d[Math.floor(d.length * 0.95)]
    const voluto = Math.max(MIN_MS, Math.min(MAX_MS, p95 + 2 * FRAME_MS))
    this.target = voluto > this.target ? voluto : this.target * 0.85 + voluto * 0.15
  }

  private secondo(t: number): Secondo {
    const at = Math.floor(t / 1000) * 1000
    let s = this.secondi[this.secondi.length - 1]
    if (!s || s.at !== at) {
      s = nuovoSecondo(at)
      this.secondi.push(s)
      while (this.secondi.length > SECONDI_STATISTICA) this.secondi.shift()
    }
    return s
  }

  /** Qualità della linea (null = nessuna sessione aperta). */
  stato(): LineaStato | null {
    if (!this.aperto) return null
    const t = this.now()
    const w = this.secondi.filter((s) => t - s.at < (SECONDI_STATISTICA + 1) * 1000)
    const sum = (k: keyof Secondo): number => w.reduce((a, s) => a + s[k], 0)
    const attesi = sum('attesi')
    const ricevuti = sum('ricevuti')
    const usciti = sum('usciti')
    // senza libopus la perdita sulla rete è anche quello che si sente
    const perdita = this.codec
      ? (100 * (sum('fec') + sum('plc') + sum('tardi'))) / Math.max(1, usciti)
      : (100 * Math.max(0, attesi - ricevuti)) / Math.max(1, attesi)
    const buchi = this.codec ? (100 * (sum('plc') + sum('vuoti'))) / Math.max(1, usciti) : perdita
    return valutaLinea({
      perdita,
      buchi,
      ritardo: this.codec ? this.target : 0,
      assente: t - this.ultimoArrivo > ASSENTE_MS
    })
  }

  private misura(t: number): void {
    if (!this.aperto || !this.o.onLinea) return
    // si guarda dopo un paio di secondi, così all'apertura non lampeggia il rosso
    if (this.secondi.length < 2 && t - this.ultimoArrivo < ASSENTE_MS) return
    // subito quando cambia colore, altrimenti ogni 3 secondi (per i numeri di "Dettagli")
    if (t - this.ultimaMisura < 1000) return
    const s = this.stato()
    if (s && (s.livello !== this.livello || t - this.ultimaMisura >= 3000)) {
      this.livello = s.livello
      this.ultimaMisura = t
      this.o.onLinea(s)
    }
  }
}

function silenzioso(pcm: Int16Array): boolean {
  let e = 0
  for (let i = 0; i < pcm.length; i++) e += pcm[i] * pcm[i]
  return Math.sqrt(e / Math.max(1, pcm.length)) < 300
}
