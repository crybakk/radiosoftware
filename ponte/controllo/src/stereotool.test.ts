import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { controllaPreset, StereoTool } from './stereotool.ts'

describe('Stereo Tool', () => {
  it('dice cosa c\'è nella cartella e salva il preset caricato', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'))
    const st = new StereoTool(dir, () => Date.parse('2026-11-17T21:00:00Z'))
    expect(st.stato()).toEqual({ disponibile: true, libreria: false, preset: null })
    writeFileSync(join(dir, 'libStereoTool.so'), 'x')
    const quando = await st.salvaPreset('Mio preset.sts', Buffer.from('[Stereo Tool]\nx=1\n'))
    expect(quando).toBe('2026-11-17T21:00:00.000Z')
    expect(readFileSync(join(dir, 'preset.sts'), 'utf8')).toContain('Stereo Tool')
    expect(st.stato()).toEqual({ disponibile: true, libreria: true, preset: { nome: 'Mio preset.sts', byte: 18, quando } })
  })

  it('cartella non collegata: niente salvataggio', async () => {
    const st = new StereoTool('/non/esiste')
    expect(st.stato().disponibile).toBe(false)
    await expect(st.salvaPreset('a.sts', Buffer.from('x'))).rejects.toThrow(/aggiorna il server/)
  })

  it('rifiuta file che non sono preset', () => {
    expect(() => controllaPreset('a.zip', Buffer.from('x'))).toThrow(/\.sts/)
    expect(() => controllaPreset('a.sts', Buffer.alloc(0))).toThrow(/vuoto/)
    expect(() => controllaPreset('a.sts', Buffer.from([0x50, 0x4b, 0, 1]))).toThrow(/non sembra/)
    expect(() => controllaPreset('a.sts', Buffer.alloc(3 * 1024 * 1024, 65))).toThrow(/grande/)
  })
})
