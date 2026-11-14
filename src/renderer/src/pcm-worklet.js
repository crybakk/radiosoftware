// Converte l'audio in PCM 16 bit stereo interleaved e lo spedisce a blocchi di 20 ms.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frames = Math.round(sampleRate / 50)
    this.buf = new Int16Array(this.frames * 2)
    this.pos = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const l = input[0]
    const r = input[1] || input[0]
    for (let i = 0; i < l.length; i++) {
      const a = Math.max(-1, Math.min(1, l[i]))
      const b = Math.max(-1, Math.min(1, r[i]))
      this.buf[this.pos++] = a < 0 ? a * 0x8000 : a * 0x7fff
      this.buf[this.pos++] = b < 0 ? b * 0x8000 : b * 0x7fff
      if (this.pos === this.buf.length) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer])
        this.buf = new Int16Array(this.frames * 2)
        this.pos = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
