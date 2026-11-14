import workletUrl from './pcm-worklet.js?url&no-inline'
import type { PonteSettings } from '../../core/types'

/**
 * Prende l'audio da inviare al ponte: il programma del computer (uscita della regia)
 * oppure un ingresso della scheda audio (es. il mix del RodeCaster con i microfoni).
 */
export class UplinkCapture {
  private node: AudioWorkletNode | null = null
  private mute: GainNode | null = null
  private stream: MediaStream | null = null
  private source: AudioNode | null = null
  private loaded = false
  private ctx: AudioContext
  private program: AudioNode
  private send: (pcm: ArrayBuffer) => void

  constructor(ctx: AudioContext, program: AudioNode, send: (pcm: ArrayBuffer) => void) {
    this.ctx = ctx
    this.program = program
    this.send = send
  }

  get active(): boolean {
    return this.node !== null
  }

  async start(p: Pick<PonteSettings, 'source' | 'inputDeviceId'>): Promise<void> {
    this.stop()
    if (!this.loaded) {
      await this.ctx.audioWorklet.addModule(workletUrl)
      this.loaded = true
    }
    const node = new AudioWorkletNode(this.ctx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    })
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.send(e.data)
    if (p.source === 'ingresso') {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: p.inputDeviceId ? { exact: p.inputDeviceId } : undefined,
          channelCount: 2,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })
      this.source = this.ctx.createMediaStreamSource(this.stream)
    } else {
      this.source = this.program
    }
    this.source.connect(node)
    // il nodo deve essere collegato all'uscita per lavorare: lo colleghiamo a volume zero
    this.mute = this.ctx.createGain()
    this.mute.gain.value = 0
    node.connect(this.mute)
    this.mute.connect(this.ctx.destination)
    this.node = node
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  stop(): void {
    if (this.node) {
      try {
        this.source?.disconnect(this.node)
      } catch {
        // già scollegato
      }
      this.node.port.onmessage = null
      this.node.disconnect()
    }
    this.mute?.disconnect()
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.node = null
    this.mute = null
    this.stream = null
    this.source = null
  }
}

/** Elenco degli ingressi audio (microfoni, RodeCaster…). */
export async function listInputDevices(): Promise<{ deviceId: string; label: string }[]> {
  try {
    // serve il permesso perché i nomi siano visibili
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const t of s.getTracks()) t.stop()
  } catch {
    // senza permesso mostriamo comunque l'elenco
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  const inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  return [{ deviceId: '', label: 'Predefinito di Windows' }, ...inputs.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Ingresso ${i + 1}` }))]
}
