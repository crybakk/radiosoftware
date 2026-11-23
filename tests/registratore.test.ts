import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { parseFile } from 'music-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { recordArgs, recordingFileName, StudioRecorder } from '../src/core/registratore'

const ffmpeg = ffmpegStatic as unknown as string
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'registra-'))
  dirs.push(d)
  return d
}

/** Un secondo di tono a 440 Hz, PCM s16le stereo. */
function tone(rate: number, seconds: number): Uint8Array {
  const n = Math.round(rate * seconds)
  const b = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000)
    b.writeInt16LE(v, i * 4)
    b.writeInt16LE(v, i * 4 + 2)
  }
  return b
}

describe('nome del file', () => {
  it('data, ora e titolo, senza caratteri vietati su Windows', () => {
    expect(recordingFileName('Buongiorno: radio/live?', new Date(2026, 10, 23, 9, 5))).toBe('2026-11-23 09.05 Buongiorno radiolive.mp3')
    expect(recordingFileName('  ', new Date(2026, 0, 2, 18, 0))).toBe('2026-01-02 18.00.mp3')
    expect(recordingFileName('fine con punto.', new Date(2026, 0, 2, 18, 0))).toBe('2026-01-02 18.00 fine con punto.mp3')
  })
  it('argomenti di ffmpeg: PCM in ingresso, MP3 in uscita', () => {
    const a = recordArgs(48000, 320).join(' ')
    expect(a).toContain('-f s16le -ar 48000 -ac 2 -i pipe:0')
    expect(a).toContain('-b:a 320k')
  })
})

describe('registrazione reale con ffmpeg', () => {
  it('scrive un MP3 con l\'audio ricevuto e avvisa a fine registrazione', async () => {
    const d = dir()
    const rec = new StudioRecorder({ dir: d, ffmpeg, log: () => {} })
    rec.setSampleRate(48000)
    const finished: string[] = []
    rec.onFinished((f) => finished.push(f.file))
    const s = rec.start('Prova studio', 'prog1')
    expect(s.active).toBe(true)
    expect(() => rec.start('Altra')).toThrow(/già una registrazione/)
    for (let i = 0; i < 3; i++) {
      rec.write(tone(48000, 1))
      await new Promise((ok) => setTimeout(ok, 50))
    }
    const done = await rec.stop()
    expect(done?.programId).toBe('prog1')
    expect(done?.title).toBe('Prova studio')
    expect(finished).toEqual([done?.file])
    expect(statSync(done!.file).size).toBeGreaterThan(10_000)
    const m = await parseFile(done!.file)
    expect(m.format.duration).toBeGreaterThan(2.5)
    expect(m.format.duration).toBeLessThan(3.5)
    expect(rec.status().active).toBe(false)
    expect(await rec.stop()).toBeNull()
  }, 20_000)

  it('registrazione senza audio: nessun file da inviare', async () => {
    const d = dir()
    const rec = new StudioRecorder({ dir: d, ffmpeg, log: () => {} })
    rec.setSampleRate(48000)
    rec.start('Vuota')
    expect(await rec.stop()).toBeNull()
  }, 20_000)

  it('ffmpeg mancante: la regia non cade', async () => {
    const d = dir()
    const rec = new StudioRecorder({ dir: d, ffmpeg: join(d, 'non-esiste'), log: () => {} })
    rec.start('Senza ffmpeg')
    rec.write(tone(48000, 0.1))
    await new Promise((ok) => setTimeout(ok, 100))
    expect(await rec.stop()).toBeNull()
  }, 20_000)
})
