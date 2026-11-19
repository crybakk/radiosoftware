import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { leggiFrame, SECONDI_LIVE, secondiApplausi, secondiPubblico } from '../src/core/liveAudio'

const ffmpeg = ffmpegStatic as unknown as string
const dir = mkdtempSync(join(tmpdir(), 'live-'))
const gen = (name: string, filter: string, inputs: string[]): string => {
  const out = join(dir, name)
  execFileSync(ffmpeg, ['-v', 'error', '-y', ...inputs.flatMap((i) => ['-f', 'lavfi', '-i', i]), '-filter_complex', filter, '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', out])
  return out
}
// "musica": accordo di sinusoidi; "applausi": rumore rosa a raffiche
const MUSICA = ['sine=f=220:d=30', 'sine=f=277:d=30', 'sine=f=330:d=30']
const APPLAUSI = 'anoisesrc=c=pink:a=0.3:d=8'

describe('live riconosciuti dal suono', () => {
  it('legge piattezza e volume di ogni mezzo secondo', () => {
    const f = leggiFrame('lavfi.aspectralstats.1.flatness=0.5\nlavfi.astats.Overall.RMS_level=-20\nlavfi.aspectralstats.1.flatness=0.01\nlavfi.astats.Overall.RMS_level=-inf\n')
    expect(f).toEqual([
      { flatness: 0.5, rms: -20 },
      { flatness: 0.01, rms: -Infinity }
    ])
    expect(secondiPubblico(f)).toBe(0.5)
  })

  it('applausi all\'inizio e alla fine: live; musica con silenzio: no', async () => {
    const live = gen('live.mp3', '[3]highpass=f=300,tremolo=f=9:d=0.8[a];[0][1][2]amix=3,volume=3[m];[4]highpass=f=300,tremolo=f=9:d=0.8[b];[a][m][b]concat=n=3:v=0:a=1', [...MUSICA, APPLAUSI, APPLAUSI])
    const soloFine = gen('fine.mp3', '[0][1][2]amix=3,volume=3[m];[3]highpass=f=300,tremolo=f=9:d=0.8[b];[m][b]concat=n=2:v=0:a=1', [...MUSICA, APPLAUSI])
    const studio = gen('studio.mp3', '[0][1][2]amix=3,volume=3[m];[3][m][4]concat=n=3:v=0:a=1', [...MUSICA, 'anullsrc=r=44100:cl=stereo:d=1', 'anullsrc=r=44100:cl=stereo:d=2'])
    expect(await secondiApplausi(ffmpeg, live)).toBeGreaterThanOrEqual(SECONDI_LIVE)
    expect(await secondiApplausi(ffmpeg, soloFine)).toBeGreaterThanOrEqual(SECONDI_LIVE)
    expect(await secondiApplausi(ffmpeg, studio)).toBeLessThan(SECONDI_LIVE)
  }, 30_000)

  it('file illeggibile: errore', async () => {
    await expect(secondiApplausi(ffmpeg, join(dir, 'non-esiste.mp3'))).rejects.toThrow()
  })
})
