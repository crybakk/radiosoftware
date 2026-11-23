/**
 * Processo a parte che passa un file audio in Stereo Tool (libreria per Linux) e lo salva in MP3.
 * Lo avvia stereotoolFile.ts con la priorità più bassa (nice 19): usa un solo core e lascia sempre
 * la precedenza alla diretta.
 *
 *   node stereotoolElabora.ts <libreria> <preset> <ingresso> <uscita> <da secondi> <a secondi> <bitrate>
 * La chiave di licenza arriva nella variabile STEREOTOOL_CHIAVE (non negli argomenti, che si vedono
 * nell'elenco dei processi). Esce con 0 se tutto è andato bene; altrimenti scrive il motivo e esce con 1.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import koffi from 'koffi'

const RATE = 44100
const CH = 2
/** Fotogrammi elaborati per volta (circa 0,1 secondi). */
const BLOCK = 4096
/** Caricamento completo del preset (come "Totalinit" in Liquidsoap). */
const TOTALINIT = 10387

export function ffmpegDecodeArgs(input: string, from: number, to: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', from.toFixed(2), '-to', to.toFixed(2), '-i', input,
    '-vn', '-f', 'f32le', '-ac', String(CH), '-ar', String(RATE), 'pipe:1'
  ]
}

export function ffmpegEncodeArgs(output: string, bitrate: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'f32le', '-ar', String(RATE), '-ac', String(CH), '-i', 'pipe:0',
    '-c:a', 'libmp3lame', '-b:a', bitrate, '-map_metadata', '-1', '-f', 'mp3', output
  ]
}

async function main(): Promise<void> {
  const [lib, preset, input, output, from, to, bitrate] = process.argv.slice(2)
  const ffmpeg = process.env.FFMPEG || 'ffmpeg'
  const st = koffi.load(lib)
  const create = st.func('void *stereoTool_Create(const char *key)')
  const destroy = st.func('void stereoTool_Delete(void *h)')
  const loadPreset = st.func('bool stereoTool_LoadPreset(void *h, const char *file, int kind)')
  const latency = st.func('int stereoTool_GetLatency2(void *h, int rate, bool feedSilence)')
  const run = st.func('void stereoTool_Process(void *h, _Inout_ float *samples, int frames, int channels, int rate)')

  const key = process.env.STEREOTOOL_CHIAVE || null
  const h = create(key)
  if (!h) throw new Error('Stereo Tool non si avvia')
  try {
    if (!loadPreset(h, preset, TOTALINIT)) throw new Error('il preset di Stereo Tool non si carica')
    // ritardo di Stereo Tool: i primi fotogrammi in uscita sono silenzio, si tolgono; alla fine si
    // aggiunge altrettanto silenzio per far uscire la coda del programma
    let skip = Number(latency(h, RATE, true)) || 0
    if (skip < 0 || skip > RATE * 10) skip = 0
    let tail = skip

    const dec = spawn(ffmpeg, ffmpegDecodeArgs(input, Number(from), Number(to)), { stdio: ['ignore', 'pipe', 'pipe'] })
    const enc = spawn(ffmpeg, ffmpegEncodeArgs(output, bitrate), { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    for (const p of [dec, enc]) p.stderr?.on('data', (c: Buffer) => (err = (err + String(c)).slice(-500)))
    const finished = (p: { on(ev: 'exit', cb: (code: number | null) => void): unknown; on(ev: 'error', cb: () => void): unknown }): Promise<number | null> => new Promise((ok) => {
      p.on('exit', ok)
      p.on('error', () => ok(null))
    })
    const decDone = finished(dec)
    const encDone = finished(enc)
    enc.stdin.on('error', () => {})

    const write = async (f: Float32Array, frames: number): Promise<void> => {
      run(h, f, frames, CH, RATE)
      let start = 0
      if (skip > 0) {
        start = Math.min(skip, frames)
        skip -= start
      }
      if (start >= frames) return
      const b = Buffer.from(f.buffer, f.byteOffset + start * CH * 4, (frames - start) * CH * 4)
      if (!enc.stdin.write(Buffer.from(b))) await new Promise((ok) => enc.stdin.once('drain', ok))
    }

    const blockBytes = BLOCK * CH * 4
    let pending: Buffer = Buffer.alloc(0)
    for await (const c of dec.stdout) {
      pending = pending.length ? Buffer.concat([pending, c as Buffer]) : (c as Buffer)
      while (pending.length >= blockBytes) {
        const f = new Float32Array(BLOCK * CH)
        Buffer.from(f.buffer).set(pending.subarray(0, blockBytes))
        pending = pending.subarray(blockBytes)
        await write(f, BLOCK)
      }
    }
    if (await decDone) throw new Error(`lettura del file non riuscita${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`)
    const rest = Math.floor(pending.length / (CH * 4))
    if (rest) {
      const f = new Float32Array(rest * CH)
      Buffer.from(f.buffer).set(pending.subarray(0, rest * CH * 4))
      await write(f, rest)
    }
    while (tail > 0) {
      const n = Math.min(BLOCK, tail)
      tail -= n
      await write(new Float32Array(n * CH), n)
    }
    enc.stdin.end()
    if (await encDone) throw new Error(`scrittura dell'MP3 non riuscita${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`)
  } finally {
    destroy(h)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    }
  )
}
