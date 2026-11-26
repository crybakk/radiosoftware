import { describe, expect, it, vi } from 'vitest'
import { InvioRtc, offertaStereo } from './rtc'

class FintoPc {
  connectionState = 'new'
  iceGatheringState = 'complete'
  localDescription: { sdp: string } | null = null
  remota: string | null = null
  chiuso = false
  tracce = 0
  ontrack: ((e: unknown) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  parametri: { encodings: { maxBitrate?: number }[] } = { encodings: [{}] }
  addTrack(): void {
    this.tracce++
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n' }
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d
  }
  async setRemoteDescription(d: { sdp: string }) {
    this.remota = d.sdp
  }
  addEventListener(): void {}
  getSenders() {
    return [{ getParameters: () => this.parametri, setParameters: async (p: { encodings: { maxBitrate?: number }[] }) => void (this.parametri = p) }]
  }
  async getStats() {
    return new Map()
  }
  close(): void {
    this.chiuso = true
  }
  stato(s: string): void {
    this.connectionState = s
    this.onconnectionstatechange?.()
  }
}

function prepara() {
  const pcs: FintoPc[] = []
  const eventi: string[] = []
  const ritorni: unknown[] = []
  const r = new InvioRtc({
    rtcOfferta: (sdp) => eventi.push(`offerta:${sdp.includes('stereo=1')}`),
    rtcChiudi: () => eventi.push('chiudi'),
    stream: () => ({ getAudioTracks: () => [{}] }) as unknown as MediaStream,
    https: (on) => eventi.push(`https:${on}`),
    ritorno: (s) => ritorni.push(s),
    kbps: () => 160,
    onCambio: () => {},
    crea: () => {
      const p = new FintoPc()
      pcs.push(p)
      return p as unknown as RTCPeerConnection
    },
    attesaMs: 1000,
    riprovaMs: 5000
  })
  return { r, pcs, eventi, ritorni }
}

const aspetta = () => new Promise((ok) => setTimeout(ok, 0))

describe('offerta WebRTC dell\'app', () => {
  it('chiede stereo e FEC anche per il ritorno', () => {
    const sdp = 'a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n'
    expect(offertaStereo(sdp)).toContain('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1')
    expect(offertaStereo('a=rtpmap:96 opus/48000/2\r\n')).toContain('a=fmtp:96 stereo=1;sprop-stereo=1;useinbandfec=1')
    expect(offertaStereo('niente opus')).toBe('niente opus')
  })
})

describe('WebRTC con riserva HTTPS', () => {
  it('parte in HTTPS, passa al WebRTC quando si collega e spegne l\'HTTPS', async () => {
    const t = prepara()
    t.r.nuova()
    await aspetta()
    expect(t.eventi).toEqual(['https:true', 'offerta:true'])
    expect(t.r.via).toBe('prova')
    t.r.messaggio({ t: 'risposta', sdp: 'risposta' })
    await aspetta()
    expect(t.pcs[0].remota).toBe('risposta')
    t.pcs[0].ontrack?.({ streams: ['ritorno'] })
    t.pcs[0].stato('connected')
    expect(t.r.via).toBe('webrtc')
    expect(t.eventi.at(-1)).toBe('https:false')
    expect(t.ritorni).toEqual(['ritorno'])
    expect(t.pcs[0].parametri.encodings[0].maxBitrate).toBe(160_000)
    t.r.ferma()
  })

  it('se non si collega in tempo torna all\'HTTPS e riprova più tardi', async () => {
    vi.useFakeTimers()
    try {
      const t = prepara()
      t.r.nuova()
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(1000)
      expect(t.pcs[0].chiuso).toBe(true)
      expect(t.eventi.slice(-2)).toEqual(['chiudi', 'https:true'])
      expect(t.r.via).toBe('https')
      await vi.advanceTimersByTimeAsync(5000)
      expect(t.pcs).toHaveLength(2)
      t.r.ferma()
    } finally {
      vi.useRealTimers()
    }
  })

  it('il server dice di no (vecchio server): resta in HTTPS', async () => {
    const t = prepara()
    t.r.nuova()
    await aspetta()
    t.r.messaggio({ t: 'errore', messaggio: 'niente WebRTC' })
    expect(t.r.via).toBe('https')
    expect(t.eventi).toContain('chiudi')
    t.r.ferma()
  })

  it('caduta breve aspettata, caduta lunga: si torna all\'HTTPS', async () => {
    vi.useFakeTimers()
    try {
      const t = prepara()
      t.r.nuova()
      await vi.advanceTimersByTimeAsync(10)
      t.pcs[0].stato('connected')
      t.pcs[0].stato('disconnected')
      await vi.advanceTimersByTimeAsync(1000)
      t.pcs[0].stato('connected')
      await vi.advanceTimersByTimeAsync(5000)
      expect(t.r.via).toBe('webrtc')
      t.pcs[0].stato('disconnected')
      await vi.advanceTimersByTimeAsync(3500)
      expect(t.r.via).toBe('https')
      expect(t.ritorni.at(-1)).toBeNull()
      t.r.ferma()
    } finally {
      vi.useRealTimers()
    }
  })
})
