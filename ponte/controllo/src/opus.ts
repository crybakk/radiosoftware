/**
 * Opus dalla libreria di sistema (libopus, già installata con ffmpeg nell'immagine del controllo).
 * Serve al ricevitore delle voci (ricevitore.ts): decodifica con la correzione degli errori (FEC) e la
 * ricostruzione dei pezzi persi, poi ricodifica in alta qualità verso Liquidsoap.
 * Se la libreria non c'è il ricevitore lavora come prima (pacchetti passati così come arrivano).
 */
import koffi from 'koffi'

export const RATE = 48_000
export const CHANNELS = 2
/** OPUS_APPLICATION_AUDIO */
const APPLICATION_AUDIO = 2049
const OPUS_SET_BITRATE = 4002
const OPUS_SET_COMPLEXITY = 4010

export interface OpusDecoder {
  /** data = null: ricostruisce un pezzo perso (samples per canale). fec: usa la copia di riserva contenuta in data. */
  decode(data: Buffer | null, samples: number, fec?: boolean): Int16Array
  /** Campioni per canale di un pacchetto (0 se non valido). */
  samples(data: Buffer): number
  close(): void
}

export interface OpusEncoder {
  /** pcm interlacciato stereo, 960 campioni per canale (20 ms). */
  encode(pcm: Int16Array): Buffer
  close(): void
}

export interface OpusCodec {
  decoder(): OpusDecoder
  encoder(bitrate: number): OpusEncoder
}

const NAMES = ['libopus.so.0', 'libopus.so', 'libopus.0.dylib', 'opus.dll']

/** Carica libopus; null se non c'è (il ricevitore passa i pacchetti come prima). */
export function loadOpus(names: string[] = NAMES): OpusCodec | null {
  let lib: ReturnType<typeof koffi.load> | null = null
  for (const n of names) {
    try {
      lib = koffi.load(n)
      break
    } catch {
      // prova il prossimo nome
    }
  }
  if (!lib) return null
  const decCreate = lib.func('void *opus_decoder_create(int fs, int channels, _Out_ int *error)')
  const decDestroy = lib.func('void opus_decoder_destroy(void *st)')
  const decode = lib.func('int opus_decode(void *st, const uint8_t *data, int len, _Out_ int16_t *pcm, int frameSize, int fec)')
  const nbSamples = lib.func('int opus_packet_get_nb_samples(const uint8_t *data, int len, int fs)')
  const encCreate = lib.func('void *opus_encoder_create(int fs, int channels, int application, _Out_ int *error)')
  const encDestroy = lib.func('void opus_encoder_destroy(void *st)')
  const encode = lib.func('int opus_encode(void *st, const int16_t *pcm, int frameSize, _Out_ uint8_t *data, int maxBytes)')
  const encCtl = lib.func('int opus_encoder_ctl(void *st, int request, ...)')

  return {
    decoder(): OpusDecoder {
      const err = [0]
      let st: unknown = decCreate(RATE, CHANNELS, err)
      if (!st || err[0] !== 0) throw new Error(`decodificatore Opus non creato (${err[0]})`)
      return {
        decode(data, samples, fec = false) {
          const n = Math.max(120, Math.min(5760, samples))
          const pcm = new Int16Array(n * CHANNELS)
          const got = data ? decode(st, data, data.length, pcm, n, fec ? 1 : 0) : decode(st, null, 0, pcm, n, 0)
          if (got < 0) return new Int16Array(n * CHANNELS)
          return got === n ? pcm : pcm.subarray(0, got * CHANNELS)
        },
        samples(data) {
          const n = nbSamples(data, data.length, RATE)
          return n > 0 ? n : 0
        },
        close() {
          if (st) decDestroy(st)
          st = null
        }
      }
    },
    encoder(bitrate): OpusEncoder {
      const err = [0]
      let st: unknown = encCreate(RATE, CHANNELS, APPLICATION_AUDIO, err)
      if (!st || err[0] !== 0) throw new Error(`codificatore Opus non creato (${err[0]})`)
      encCtl(st, OPUS_SET_BITRATE, 'int', bitrate)
      encCtl(st, OPUS_SET_COMPLEXITY, 'int', 8)
      const out = Buffer.alloc(4000)
      return {
        encode(pcm) {
          const n = encode(st, pcm, pcm.length / CHANNELS, out, out.length)
          return n > 0 ? Buffer.from(out.subarray(0, n)) : Buffer.alloc(0)
        },
        close() {
          if (st) encDestroy(st)
          st = null
        }
      }
    }
  }
}
