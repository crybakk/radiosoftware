/**
 * Mixer di Radio Esterna (Web Audio): fino a 4 microfoni o canali di schede audio, più l'audio del computer.
 * Ogni ingresso ha volume, muto e indicatore; dopo la somma c'è un limitatore, così non distorce.
 * L'uscita va al server in WebRTC (rtc.ts, dal 26/11/2026) o, se l'UDP non passa, in HTTPS (MediaRecorder
 * WebM/Opus a pezzi di un quarto di secondo) e, quando si registra,
 * al registratore del computer (stesso audio, qualità più alta). La cuffia ha un mix a parte, più il ritorno
 * dello studio (in WebRTC, o un flusso MP3 dal server se si è in HTTPS, su un altro lettore, sulla stessa uscita).
 */
import { guadagno } from '../../shared/mixer'
import { InvioRtc } from './rtc'
import type { Canale, ImpostazioniMixer } from '../../shared/api'

const api = window.esterna

interface Ingresso {
  id: string
  chiave: string
  stream: MediaStream
  sorgente: MediaStreamAudioSourceNode
  extra: AudioNode[]
  gain: GainNode
  analizzatore: AnalyserNode
  errore: string | null
}

type AudioConUscita = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
type ContestoConUscita = AudioContext & { setSinkId?: (id: string) => Promise<void> }

/** Picco (0…1) di un analizzatore. */
function picco(a: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  a.getFloatTimeDomainData(buf)
  let p = 0
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i])
    if (v > p) p = v
  }
  return p
}

const MIME = 'audio/webm;codecs=opus'

export class Motore {
  // frequenza della scheda audio (niente ricampionamento continuo) e buffer un po' più ampio di "interactive":
  // su Windows con buffer minimi l'audio si interrompeva (anche quello mandato alla radio)
  readonly ctx: ContestoConUscita = new AudioContext({ latencyHint: 'balanced' })
  private readonly bus = this.ctx.createGain()
  private readonly limitatore = this.ctx.createDynamicsCompressor()
  private readonly uscita = this.ctx.createGain()
  private readonly analizzatoreUscita = this.ctx.createAnalyser()
  private readonly dest = this.ctx.createMediaStreamDestination()
  private readonly cuffiaBus = this.ctx.createGain()
  /** Solo se il sistema non sa scegliere l'uscita del mixer: cuffia tramite un elemento audio (meno stabile). */
  private readonly cuffiaDiretta = typeof this.ctx.setSinkId === 'function'
  private readonly cuffia: AudioConUscita = new Audio()
  private readonly ritorno: AudioConUscita = new Audio()
  private readonly ingressi = new Map<string, Ingresso>()
  private pc: Ingresso | null = null
  private pcInCuffia = false
  private readonly buf = new Float32Array(2048)
  private invio: MediaRecorder | null = null
  private generazione = 0
  private catena: Promise<void> = Promise.resolve()
  private kbps = 160
  private registra: MediaRecorder | null = null
  private ritornoUrl: string | null = null
  private ritornoAcceso = false
  /** Ritorno dello studio in WebRTC (più veloce dell'MP3). */
  private ritornoRtc: MediaStream | null = null
  /** Invio in HTTPS acceso (spento quando il WebRTC è collegato). */
  private httpsAcceso = true
  readonly rtc = new InvioRtc({
    rtcOfferta: (sdp) => api.rtcOfferta(sdp),
    rtcChiudi: () => api.rtcChiudi(),
    stream: () => this.dest.stream,
    https: (on) => this.inviaHttps(on),
    ritorno: (st) => this.setRitornoRtc(st),
    kbps: () => this.kbps,
    onCambio: () => this.onCambio()
  })
  /** Errori degli ingressi, per la finestra. */
  errori = new Map<string, string>()
  onCambio: () => void = () => {}

  constructor() {
    // limitatore: i picchi restano sotto 0 dBFS, attacco rapido (la voce e i colpi sul microfono non distorcono)
    this.limitatore.threshold.value = -4
    this.limitatore.knee.value = 3
    this.limitatore.ratio.value = 20
    this.limitatore.attack.value = 0.002
    this.limitatore.release.value = 0.15
    this.bus.connect(this.limitatore)
    this.limitatore.connect(this.uscita)
    this.uscita.gain.value = 1.15
    this.uscita.connect(this.analizzatoreUscita)
    this.uscita.connect(this.dest)
    this.analizzatoreUscita.fftSize = 2048
    if (this.cuffiaDiretta) {
      // la cuffia esce direttamente dal mixer, senza passare da un flusso intermedio
      this.cuffiaBus.connect(this.ctx.destination)
    } else {
      const d = this.ctx.createMediaStreamDestination()
      this.cuffiaBus.connect(d)
      this.cuffia.srcObject = d.stream
      void this.cuffia.play().catch(() => {})
    }
    this.ritorno.preload = 'none'
  }

  // ---------- ingressi ----------

  private crea(id: string, chiave: string, stream: MediaStream, parte: Canale['parte']): Ingresso {
    const sorgente = this.ctx.createMediaStreamSource(stream)
    const gain = this.ctx.createGain()
    const analizzatore = this.ctx.createAnalyser()
    analizzatore.fftSize = 2048
    const extra: AudioNode[] = []
    if (parte === 'stereo') {
      sorgente.connect(gain)
    } else {
      // un canale solo della scheda (es. il microfono sull'ingresso 1): lo si manda su tutti e due i lati
      const split = this.ctx.createChannelSplitter(2)
      const merge = this.ctx.createChannelMerger(2)
      sorgente.connect(split)
      const n = parte === 'sinistro' ? 0 : 1
      split.connect(merge, n, 0)
      split.connect(merge, n, 1)
      merge.connect(gain)
      extra.push(split, merge)
    }
    gain.connect(analizzatore)
    gain.connect(this.bus)
    return { id, chiave, stream, sorgente, extra, gain, analizzatore, errore: null }
  }

  private chiudi(i: Ingresso): void {
    try {
      i.sorgente.disconnect()
      for (const n of i.extra) n.disconnect()
      i.gain.disconnect()
    } catch {
      // già scollegato
    }
    for (const t of i.stream.getTracks()) t.stop()
  }

  /** Allinea gli ingressi alle impostazioni (apre i dispositivi nuovi, chiude quelli tolti, cambia i volumi). */
  async applica(m: ImpostazioniMixer): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
    const voluti = new Set(m.canali.map((c) => c.id))
    for (const [id, i] of this.ingressi) {
      if (!voluti.has(id)) {
        this.chiudi(i)
        this.ingressi.delete(id)
        this.errori.delete(id)
      }
    }
    for (const c of m.canali) {
      const chiave = `${c.deviceId}|${c.parte}`
      let i = this.ingressi.get(c.id)
      if (i && i.chiave !== chiave) {
        this.chiudi(i)
        this.ingressi.delete(c.id)
        i = undefined
      }
      if (!i) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: c.deviceId ? { exact: c.deviceId } : undefined,
              // per la radio: niente cancellazione dell'eco, riduzione del rumore o volume automatico
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: { ideal: 2 }
            }
          })
          i = this.crea(c.id, chiave, stream, c.parte)
          this.ingressi.set(c.id, i)
          this.errori.delete(c.id)
        } catch (e) {
          this.errori.set(c.id, e instanceof Error && e.name === 'NotAllowedError' ? 'permesso del microfono negato' : 'dispositivo non disponibile')
          continue
        }
      }
      i.gain.gain.setTargetAtTime(guadagno(c.volumeDb, c.muto), this.ctx.currentTime, 0.02)
      // il microfono si sente in cuffia (senza ritardo della radio)
      try {
        i.gain.disconnect(this.cuffiaBus)
      } catch {
        // non era collegato
      }
      i.gain.connect(this.cuffiaBus)
    }
    await this.applicaPc(m)
    this.cuffiaBus.gain.setTargetAtTime(m.cuffiaVolume, this.ctx.currentTime, 0.02)
    await this.setCuffia(m.cuffiaId)
    this.ritorno.volume = Math.max(0, Math.min(1, m.ritornoVolume))
    this.ritornoAcceso = m.ritorno
    this.aggiornaRitorno()
    if (m.kbps !== this.kbps) {
      this.kbps = m.kbps
      this.riavviaInvio()
      this.rtc.aggiornaKbps()
    }
    this.onCambio()
  }

  private async applicaPc(m: ImpostazioniMixer): Promise<void> {
    if (!m.pc.attivo) {
      if (this.pc) this.chiudi(this.pc)
      this.pc = null
      this.errori.delete('pc')
      return
    }
    if (!this.pc) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints
        })
        // serve solo l'audio
        for (const t of stream.getVideoTracks()) {
          t.stop()
          stream.removeTrack(t)
        }
        if (!stream.getAudioTracks().length) throw new Error('nessun audio')
        this.pc = this.crea('pc', 'pc', stream, 'stereo')
        this.errori.delete('pc')
        // se il sistema smette di dare l'audio (permesso tolto), lo si dice
        stream.getAudioTracks()[0].addEventListener('ended', () => {
          this.errori.set('pc', 'audio del computer interrotto: spegnilo e riaccendilo')
          this.onCambio()
        })
      } catch {
        this.errori.set(
          'pc',
          api.piattaforma === 'darwin'
            ? 'audio del computer non disponibile: serve macOS 13 o più recente e il permesso "Registrazione schermo e audio di sistema" per Radio Esterna (Impostazioni di Sistema → Privacy e sicurezza)'
            : 'audio del computer non disponibile'
        )
        return
      }
    }
    this.pc.gain.gain.setTargetAtTime(guadagno(m.pc.volumeDb, m.pc.muto), this.ctx.currentTime, 0.02)
    if (m.pc.inCuffia !== this.pcInCuffia) {
      if (m.pc.inCuffia) this.pc.gain.connect(this.cuffiaBus)
      else {
        try {
          this.pc.gain.disconnect(this.cuffiaBus)
        } catch {
          // non era collegato
        }
      }
      this.pcInCuffia = m.pc.inCuffia
    }
  }

  private cuffiaId: string | null = null

  private async setCuffia(id: string): Promise<void> {
    if (id === this.cuffiaId) return
    this.cuffiaId = id
    if (this.cuffiaDiretta) await this.ctx.setSinkId!(id).catch(() => {})
    for (const a of this.cuffiaDiretta ? [this.ritorno] : [this.cuffia, this.ritorno]) {
      if (a.setSinkId) await a.setSinkId(id).catch(() => {})
    }
  }

  // ---------- ritorno dello studio ----------

  setRitornoUrl(url: string | null): void {
    if (url === this.ritornoUrl) return
    this.ritornoUrl = url
    this.aggiornaRitorno(true)
  }

  /** Ritorno in WebRTC arrivato (o finito): prende il posto dell'MP3. */
  setRitornoRtc(st: MediaStream | null): void {
    if (st === this.ritornoRtc) return
    this.ritornoRtc = st
    this.aggiornaRitorno(true)
  }

  private aggiornaRitorno(forza = false): void {
    if (this.ritornoAcceso && this.ritornoRtc) {
      if (forza || this.ritorno.srcObject !== this.ritornoRtc || this.ritorno.paused) {
        this.ritorno.removeAttribute('src')
        this.ritorno.srcObject = this.ritornoRtc
        void this.ritorno.play().catch(() => {})
      }
      return
    }
    if (this.ritorno.srcObject) {
      this.ritorno.pause()
      this.ritorno.srcObject = null
    }
    const vuole = this.ritornoAcceso && !!this.ritornoUrl
    if (!vuole) {
      if (!this.ritorno.paused || this.ritorno.src) {
        this.ritorno.pause()
        this.ritorno.removeAttribute('src')
        this.ritorno.load()
      }
      return
    }
    if (forza || this.ritorno.paused) {
      this.ritorno.src = this.ritornoUrl!
      void this.ritorno.play().catch(() => {})
    }
  }

  /** Il ritorno si è fermato (rete, regia spenta): si riprova ogni tanto. */
  controllaRitorno(): void {
    if (this.ritornoRtc) {
      if (this.ritornoAcceso && this.ritorno.paused) this.aggiornaRitorno(true)
      return
    }
    if (this.ritornoAcceso && this.ritornoUrl && (this.ritorno.paused || this.ritorno.error || this.ritorno.ended)) this.aggiornaRitorno(true)
  }

  ritornoInAscolto(): boolean {
    return !this.ritorno.paused && !this.ritorno.error
  }

  /** Il ritorno arriva in WebRTC (mezzo secondo di ritardo o meno). */
  ritornoVeloce(): boolean {
    return !!this.ritornoRtc
  }

  // ---------- invio al server ----------

  avviaInvio(): void {
    this.riavviaInvio()
  }

  /** HTTPS acceso (riserva) o spento (WebRTC collegato). */
  inviaHttps(on: boolean): void {
    this.httpsAcceso = on
    if (on) {
      if (!this.invio) this.riavviaInvio()
      return
    }
    const vecchio = this.invio
    this.invio = null
    this.generazione++
    if (vecchio && vecchio.state !== 'inactive') vecchio.stop()
  }

  /** Ricomincia il flusso verso il server (nuova connessione o qualità cambiata): il primo pezzo ha l'intestazione. */
  riavviaInvio(): void {
    // in WebRTC l'HTTPS resta spento
    if (!this.httpsAcceso) return
    const vecchio = this.invio
    this.invio = null
    this.generazione++
    if (vecchio && vecchio.state !== 'inactive') vecchio.stop()
    const gen = this.generazione
    const r = new MediaRecorder(this.dest.stream, { mimeType: MIME, audioBitsPerSecond: this.kbps * 1000 })
    let primo = true
    r.ondataavailable = (e) => {
      if (gen !== this.generazione || !e.data.size) return
      const inizio = primo
      primo = false
      // i pezzi vanno mandati nell'ordine giusto
      this.catena = this.catena.then(async () => {
        const b = await e.data.arrayBuffer()
        if (gen === this.generazione) api.audio(b, inizio)
      })
    }
    r.start(250)
    this.invio = r
  }

  // ---------- registrazione sul computer (alta qualità) ----------

  avviaRegistrazione(): void {
    if (this.registra) return
    const r = new MediaRecorder(this.dest.stream, { mimeType: MIME, audioBitsPerSecond: 320_000 })
    let catena: Promise<void> = Promise.resolve()
    r.ondataavailable = (e) => {
      if (!e.data.size) return
      catena = catena.then(async () => api.pezzoRegistrazione(await e.data.arrayBuffer()))
    }
    r.start(500)
    this.registra = r
  }

  fermaRegistrazione(): void {
    const r = this.registra
    this.registra = null
    if (r && r.state !== 'inactive') r.stop()
  }

  // ---------- livelli ----------

  livelli(): { canali: Map<string, number>; pc: number; uscita: number; riduzione: number } {
    const canali = new Map<string, number>()
    for (const [id, i] of this.ingressi) canali.set(id, picco(i.analizzatore, this.buf))
    return {
      canali,
      pc: this.pc ? picco(this.pc.analizzatore, this.buf) : 0,
      uscita: picco(this.analizzatoreUscita, this.buf),
      riduzione: this.limitatore.reduction
    }
  }
}

/** Dispositivi audio (dopo il primo permesso i nomi sono leggibili). */
export async function dispositivi(): Promise<{ ingressi: MediaDeviceInfo[]; uscite: MediaDeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices()
  return {
    ingressi: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'),
    uscite: all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  }
}
