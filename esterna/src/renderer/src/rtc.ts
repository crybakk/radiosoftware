/**
 * Invio dell'audio in WebRTC con riserva HTTPS (scelta di cristian, 26/11/2026).
 *
 * A ogni collegamento al server si parte in HTTPS (come prima: l'audio arriva subito) e intanto si prova il
 * WebRTC (UDP). Appena il WebRTC è collegato l'HTTPS si ferma: sul 4G l'UDP con la correzione degli errori
 * (FEC) regge molto meglio, e dalla stessa connessione torna il ritorno in cuffia con mezzo secondo di ritardo.
 * Se il WebRTC non si collega (alcuni wifi bloccano l'UDP) o cade, si torna da soli all'HTTPS e si riprova
 * più tardi. Chi è fuori non deve fare niente.
 */
import type { MessaggioRtc } from '../../shared/api'

export type Via = 'https' | 'prova' | 'webrtc'

export interface RtcDeps {
  rtcOfferta(sdp: string): void
  rtcChiudi(): void
  /** Uscita del mixer da mandare. */
  stream(): MediaStream
  /** Invio in HTTPS acceso o spento. */
  https(on: boolean): void
  /** Ritorno dello studio in WebRTC (null = si torna all'MP3). */
  ritorno(stream: MediaStream | null): void
  /** Qualità scelta (kbit/s). */
  kbps(): number
  onCambio(): void
  crea?: (cfg: RTCConfiguration) => RTCPeerConnection
  /** Attesa massima per collegarsi (ms). */
  attesaMs?: number
  /** Dopo una rinuncia si riprova tra (ms). */
  riprovaMs?: number
}

/**
 * Chiede l'audio in stereo anche nel ritorno (la musica della regia) e la copia di riserva (FEC).
 * Il server nella risposta chiede lo stesso per l'audio che riceve.
 */
export function offertaStereo(sdp: string): string {
  const pt = /^a=rtpmap:(\d+) opus\/48000\/2/im.exec(sdp)?.[1]
  if (!pt) return sdp
  const re = new RegExp(`^a=fmtp:${pt} (.*)$`, 'im')
  const extra = ['stereo=1', 'sprop-stereo=1', 'useinbandfec=1']
  if (re.test(sdp)) {
    return sdp.replace(re, (_r, p: string) => {
      const parti = p.split(';').map((x) => x.trim()).filter(Boolean)
      for (const e of extra) if (!parti.some((x) => x.split('=')[0] === e.split('=')[0])) parti.push(e)
      return `a=fmtp:${pt} ${parti.join(';')}`
    })
  }
  return sdp.replace(/^(a=rtpmap:\d+ opus\/48000\/2\r?\n)/im, `$1a=fmtp:${pt} ${extra.join(';')}\r\n`)
}

export class InvioRtc {
  via: Via = 'https'
  /** kbit/s mandati in WebRTC (misurati). */
  kbps = 0
  private pc: RTCPeerConnection | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private riprova: ReturnType<typeof setTimeout> | null = null
  private misura: ReturnType<typeof setInterval> | null = null
  private staccato: ReturnType<typeof setTimeout> | null = null
  private attivo = false
  private readonly d: RtcDeps

  constructor(d: RtcDeps) {
    this.d = d
  }

  /** Collegamento nuovo con il server: si parte in HTTPS e si prova il WebRTC. */
  nuova(): void {
    this.attivo = true
    this.chiudiPc()
    this.imposta('https')
    this.d.https(true)
    void this.prova()
  }

  /** Server scollegato o uscita: si chiude tutto. */
  ferma(): void {
    this.attivo = false
    this.chiudiPc()
    if (this.riprova) clearTimeout(this.riprova)
    this.riprova = null
    this.imposta('https')
  }

  messaggio(m: MessaggioRtc): void {
    if (m.t === 'nuova') return this.nuova()
    const pc = this.pc
    if (!pc) return
    if (m.t === 'risposta') {
      pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => this.rinuncia())
    } else {
      this.rinuncia()
    }
  }

  private async prova(): Promise<void> {
    if (!this.attivo) return
    if (this.riprova) clearTimeout(this.riprova)
    this.riprova = null
    const crea = this.d.crea ?? ((cfg: RTCConfiguration) => new RTCPeerConnection(cfg))
    const pc = crea({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    this.pc = pc
    this.imposta('prova')
    const stream = this.d.stream()
    for (const t of stream.getAudioTracks()) pc.addTrack(t, stream)
    pc.ontrack = (e) => {
      if (this.pc === pc) this.d.ritorno(e.streams[0] ?? new MediaStream([e.track]))
    }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      const s = pc.connectionState
      if (s === 'connected') {
        if (this.staccato) clearTimeout(this.staccato)
        this.staccato = null
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        if (this.via !== 'webrtc') this.collegato(pc)
      } else if (s === 'failed' || s === 'closed') {
        this.rinuncia()
      } else if (s === 'disconnected' && !this.staccato) {
        // un'interruzione breve si aspetta, poi si torna all'HTTPS
        this.staccato = setTimeout(() => {
          this.staccato = null
          if (this.pc === pc && pc.connectionState !== 'connected') this.rinuncia()
        }, 3000)
      }
    }
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.pc === pc && pc.connectionState !== 'connected') this.rinuncia()
    }, this.d.attesaMs ?? 12_000)
    try {
      const offerta = await pc.createOffer()
      await pc.setLocalDescription({ type: 'offer', sdp: offertaStereo(offerta.sdp ?? '') })
      await aspettaIce(pc)
      if (this.pc !== pc) return
      this.d.rtcOfferta(pc.localDescription?.sdp ?? '')
    } catch {
      if (this.pc === pc) this.rinuncia()
    }
  }

  private collegato(pc: RTCPeerConnection): void {
    this.imposta('webrtc')
    this.d.https(false)
    // qualità scelta come tetto: se la linea fatica il browser scende da solo
    for (const s of pc.getSenders()) {
      const p = s.getParameters()
      if (!p.encodings?.length) p.encodings = [{}]
      p.encodings[0].maxBitrate = this.d.kbps() * 1000
      p.encodings[0].priority = 'high'
      p.encodings[0].networkPriority = 'high'
      void s.setParameters(p).catch(() => {})
    }
    let prima: { byte: number; t: number } | null = null
    this.misura = setInterval(() => {
      void pc.getStats().then((r) => {
        let byte = 0
        r.forEach((x: { type: string; kind?: string; bytesSent?: number }) => {
          if (x.type === 'outbound-rtp' && x.kind === 'audio') byte += x.bytesSent ?? 0
        })
        const t = Date.now()
        if (prima && t > prima.t) this.kbps = Math.round(((byte - prima.byte) * 8) / (t - prima.t))
        prima = { byte, t }
        this.d.onCambio()
      })
    }, 2000)
  }

  /** Il WebRTC non passa o è caduto: si torna all'HTTPS e si riprova tra un minuto. */
  private rinuncia(): void {
    if (!this.pc) return
    this.chiudiPc()
    this.d.rtcChiudi()
    this.imposta('https')
    this.d.https(true)
    if (this.attivo && !this.riprova) {
      this.riprova = setTimeout(() => {
        this.riprova = null
        void this.prova()
      }, this.d.riprovaMs ?? 60_000)
    }
  }

  /** Nuova qualità scelta nel mixer. */
  aggiornaKbps(): void {
    if (this.via === 'webrtc' && this.pc) {
      for (const s of this.pc.getSenders()) {
        const p = s.getParameters()
        if (p.encodings?.[0]) {
          p.encodings[0].maxBitrate = this.d.kbps() * 1000
          void s.setParameters(p).catch(() => {})
        }
      }
    }
  }

  private chiudiPc(): void {
    for (const t of [this.timer, this.staccato]) if (t) clearTimeout(t)
    this.timer = null
    this.staccato = null
    if (this.misura) clearInterval(this.misura)
    this.misura = null
    this.kbps = 0
    const pc = this.pc
    this.pc = null
    if (pc) {
      pc.onconnectionstatechange = null
      pc.ontrack = null
      pc.close()
      this.d.ritorno(null)
    }
  }

  private imposta(v: Via): void {
    if (v === this.via) return
    this.via = v
    this.d.onCambio()
  }
}

function aspettaIce(pc: RTCPeerConnection): Promise<void> {
  return new Promise((ok) => {
    if (pc.iceGatheringState === 'complete') return ok()
    const t = setTimeout(ok, 2500)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t)
        ok()
      }
    })
  })
}
