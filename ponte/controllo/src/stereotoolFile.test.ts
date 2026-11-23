import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFile } from 'music-metadata'
import { describe, expect, it } from 'vitest'
import { elaboraConStereoTool, stereoToolMancante } from './stereotoolFile.ts'
import { ffmpegDecodeArgs } from './stereotoolElabora.ts'

/**
 * Finta libreria di Stereo Tool, con le stesse funzioni della vera: dimezza il volume, ritarda l'audio
 * di 1000 fotogrammi (come il ritardo vero di Stereo Tool) e rifiuta un preset vuoto.
 */
const FINTA = `
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#define LAT 1000
typedef struct { float buf[LAT * 2]; int pos; } st;
void *stereoTool_Create(const char *key) { return calloc(1, sizeof(st)); }
void stereoTool_Delete(void *h) { free(h); }
int stereoTool_LoadPreset(void *h, const char *f, int k) {
  FILE *p = fopen(f, "r"); if (!p) return 0; int c = fgetc(p); fclose(p); return c != EOF && k == 10387;
}
int stereoTool_GetLatency2(void *h, int rate, int feed) { return LAT; }
void stereoTool_Process(void *h, float *s, int n, int ch, int rate) {
  st *t = h;
  for (int i = 0; i < n * ch; i++) { float in = s[i] * 0.5f; s[i] = t->buf[t->pos]; t->buf[t->pos] = in; t->pos = (t->pos + 1) % (LAT * 2); }
}
`

function gccOk(): boolean {
  try {
    execFileSync('gcc', ['--version'], { stdio: 'ignore' })
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('Stereo Tool sui file', () => {
  it('argomenti di lettura: taglio e PCM float', () => {
    expect(ffmpegDecodeArgs('/a.mp3', 10, 70.5).join(' ')).toContain('-ss 10.00 -to 70.50 -i /a.mp3 -vn -f f32le -ac 2 -ar 44100')
  })

  it('senza libreria o preset dice cosa manca', () => {
    const d = mkdtempSync(join(tmpdir(), 'st-'))
    expect(stereoToolMancante(d)).toMatch(/libreria/)
    writeFileSync(join(d, 'libStereoTool.so'), 'x')
    expect(stereoToolMancante(d)).toMatch(/preset/)
  })

  it.skipIf(!gccOk())('taglia, elabora e scrive l\'MP3 della durata giusta', async () => {
    const d = mkdtempSync(join(tmpdir(), 'st-'))
    writeFileSync(join(d, 'finta.c'), FINTA)
    execFileSync('gcc', ['-shared', '-fPIC', '-O2', '-o', join(d, 'libStereoTool.so'), join(d, 'finta.c')])
    writeFileSync(join(d, 'preset.sts'), '[Stereo Tool]\n')
    const input = join(d, 'in.mp3')
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-ac', '2', '-b:a', '320k', input])
    const out = join(d, 'out.mp3')
    await elaboraConStereoTool(input, out, 2, 8, { dir: d, key: '', bitrate: '128k', nice: '' })
    const m = await parseFile(out)
    expect(m.format.duration).toBeGreaterThan(5.8)
    expect(m.format.duration).toBeLessThan(6.3)
  }, 60_000)

  it.skipIf(!gccOk())('preset che non si carica: errore chiaro', async () => {
    const d = mkdtempSync(join(tmpdir(), 'st-'))
    writeFileSync(join(d, 'finta.c'), FINTA)
    execFileSync('gcc', ['-shared', '-fPIC', '-o', join(d, 'libStereoTool.so'), join(d, 'finta.c')])
    writeFileSync(join(d, 'preset.sts'), '')
    const input = join(d, 'in.mp3')
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=2', '-ac', '2', input])
    await expect(elaboraConStereoTool(input, join(d, 'o.mp3'), 0, 2, { dir: d, key: '', bitrate: '128k', nice: '' })).rejects.toThrow(/preset/)
  }, 60_000)
})
