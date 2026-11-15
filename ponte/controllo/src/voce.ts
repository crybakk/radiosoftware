/**
 * Microfono remoto: il conduttore parla dal browser del pannello (WebRTC).
 *
 * Browser ⇄ (WebRTC, Opus) ⇄ controllo ⇄ (RTP su rete Docker) ⇄ Liquidsoap
 *   - la voce va a Liquidsoap, che la mescola al programma abbassando la musica;
 *   - Liquidsoap rimanda il programma senza la voce (ritorno in cuffia, "mix-minus").
 *
 * Un solo microfono remoto alla volta. Se il conduttore si scollega, il microfono
 * esce da solo dall'onda.
 */
import { createSocket, type Socket } from 'node:dgram'
import { lookup } from 'node:dns/promises'
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from 'werift'
import type { MicStatus } from './protocol.ts'
import { RtpNormalizer } from './rtp.ts'

/** Una sessione WebRTC aperta con un browser. */
export interface RtcSession {
  answer: string
  close(): void
}

export interface RtcSessionHandlers {
  /** Pacchetto RTP della voce arrivato dal browser. */
  onVoice(pkt: Buffer): void
  /** La connessione si è chiusa o è caduta. */
  onEnd(): void
}

export type SessionFactory = (offerSdp: string, h: RtcSessionHandlers, host?: string) => Promise<RtcSession & { sendReturn(pkt: Buffer): void }>

export interface VoiceOptions {
  factory: SessionFactory
  /** Inoltra la voce a Liquidsoap. */
  sendVoice(pkt: Buffer): void
  /** Mette in onda o toglie la voce in Liquidsoap. */
  setOnAir(on: boolean): Promise<boolean>
}

export class VoiceHub {
  private owner: object | null = null
  private user: string | null = null
  private onAir = false
  private session: (RtcSession & { sendReturn(pkt: Buffer): void }) | null = null
  private normalizer = new RtpNormalizer()
  onChange: (s: MicStatus) => void = () => {}

  private readonly opts: VoiceOptions

  constructor(opts: VoiceOptions) {
    this.opts = opts
  }

  status(): MicStatus {
    return { user: this.user, onAir: this.onAir }
  }

  /**
   * Il browser chiede di aprire il microfono: risponde con la risposta SDP.
   * host = nome con cui il browser ha aperto il pannello (per esempio il dominio):
   * il suo indirizzo viene annunciato al browser per il collegamento audio.
   */
  async open(owner: object, user: string, offerSdp: string, host?: string): Promise<string> {
    if (this.owner && this.owner !== owner) throw new Error(`il microfono remoto è già usato da ${this.user}`)
    if (this.owner === owner) this.drop(false)
    this.owner = owner
    this.user = user
    let session: (RtcSession & { sendReturn(pkt: Buffer): void }) | null = null
    try {
      session = await this.opts.factory(offerSdp, {
        onVoice: (pkt) => {
          if (this.session !== session) return
          const out = this.normalizer.map(pkt)
          if (out) this.opts.sendVoice(out)
        },
        onEnd: () => {
          if (this.session === session) this.close(owner)
        }
      }, host)
    } catch (e) {
      if (this.owner === owner) {
        this.owner = null
        this.user = null
        this.emit()
      }
      throw e
    }
    if (this.owner !== owner) {
      // chiuso mentre si apriva
      session.close()
      throw new Error('microfono chiuso')
    }
    this.session = session
    this.emit()
    return session.answer
  }

  /** Mette in onda o toglie la voce; solo chi ha aperto il microfono. */
  async setMic(owner: object, on: boolean): Promise<void> {
    if (this.owner !== owner || !this.session) throw new Error('apri prima il microfono')
    if (!(await this.opts.setOnAir(on))) throw new Error('il mixer del ponte non risponde')
    if (this.owner !== owner) return
    this.onAir = on
    this.emit()
  }

  /** Il programma senza la voce, da rimandare in cuffia al conduttore. */
  sendReturn(pkt: Buffer): void {
    this.session?.sendReturn(pkt)
  }

  /** Chiude il microfono di questo pannello (pannello chiuso, rete caduta, tasto "Chiudi"). */
  close(owner: object): void {
    if (this.owner !== owner) return
    this.drop(true)
  }

  private drop(notify: boolean): void {
    const wasOnAir = this.onAir
    this.session?.close()
    this.session = null
    this.owner = null
    this.user = null
    this.onAir = false
    if (wasOnAir) void this.opts.setOnAir(false)
    if (notify) this.emit()
  }

  private emit(): void {
    this.onChange(this.status())
  }
}

// ---------- WebRTC con werift ----------

export interface WeriftOptions {
  /** Porte UDP usate per WebRTC (da aprire sul router). */
  portRange: [number, number]
  /** Server STUN, per esempio "stun:stun.l.google.com:19302"; vuoto = nessuno. */
  stun: string
  /** Altri indirizzi o nomi da annunciare al browser (oltre a quello con cui ha aperto il pannello). */
  addresses: string[]
}

async function resolveAll(names: string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const n of names) {
    const r = await lookup(n, { family: 4 }).catch(() => null)
    if (r) out.add(r.address)
    else console.error(`[microfono] indirizzo non risolto: ${n}`)
  }
  return [...out]
}

export function weriftFactory(o: WeriftOptions): SessionFactory {
  return async (offerSdp, h, host) => {
    const pc = new RTCPeerConnection({
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
            // qualità radio: chiede al browser fino a 128 kbit/s
            parameters: 'minptime=10;useinbandfec=1;maxaveragebitrate=128000'
          })
        ]
      },
      icePortRange: o.portRange,
      iceServers: o.stun ? [{ urls: o.stun }] : [],
      iceAdditionalHostAddresses: await resolveAll(host ? [host, ...o.addresses] : o.addresses)
    })
    const ret = new MediaStreamTrack({ kind: 'audio' })
    pc.addTransceiver(ret, { direction: 'sendrecv' })
    pc.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => h.onVoice(rtp.serialize()))
    })
    let ended = false
    const end = (): void => {
      if (ended) return
      ended = true
      h.onEnd()
    }
    pc.connectionStateChange.subscribe((s) => {
      // 'disconnected' può essere un'interruzione breve (4G): si aspetta 'failed'
      if (s === 'failed' || s === 'closed') end()
    })
    // se il browser non si collega entro 20 secondi, si chiude
    const guard = setTimeout(() => {
      if (pc.connectionState !== 'connected') {
        void pc.close()
        end()
      }
    }, 20_000)
    pc.connectionStateChange.subscribe((s) => s === 'connected' && clearTimeout(guard))
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      await pc.setLocalDescription(await pc.createAnswer())
    } catch (e) {
      clearTimeout(guard)
      void pc.close()
      throw new Error(`offerta del browser non valida: ${e instanceof Error ? e.message : String(e)}`)
    }
    return {
      answer: pc.localDescription?.sdp ?? '',
      sendReturn: (pkt) => {
        if (pc.connectionState === 'connected') ret.writeRtp(pkt)
      },
      close: () => {
        clearTimeout(guard)
        ended = true
        void pc.close()
      }
    }
  }
}

// ---------- collegamento con Liquidsoap ----------

/** Socket UDP: manda la voce a Liquidsoap e riceve il ritorno da Liquidsoap. */
export function voiceSockets(
  voiceTarget: { host: string; port: number },
  returnPort: number,
  onReturn: (pkt: Buffer) => void
): { sendVoice(pkt: Buffer): void; close(): void } {
  const out: Socket = createSocket('udp4')
  const rx: Socket = createSocket('udp4')
  rx.on('message', (m) => {
    // solo RTP: i pacchetti RTCP (tipo 200-204) non vanno al browser
    if (m.length >= 12 && m[0] >> 6 === 2 && !(m[1] >= 200 && m[1] <= 204)) onReturn(m)
  })
  rx.on('error', (e) => console.error(`[microfono] ritorno: ${e.message}`))
  out.on('error', (e) => console.error(`[microfono] invio voce: ${e.message}`))
  rx.bind(returnPort)
  let target: string | null = null
  const resolve = (): void => {
    lookup(voiceTarget.host, { family: 4 })
      .then((r) => (target = r.address))
      .catch(() => setTimeout(resolve, 5000))
  }
  resolve()
  return {
    sendVoice: (pkt) => {
      if (target) out.send(pkt, voiceTarget.port, target)
    },
    close: () => {
      out.close()
      rx.close()
    }
  }
}
