import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findGuideDir, guideImageName, guidePage } from './guida.ts'

describe('guida nel pannello', () => {
  it('trova la guida montata o quella del repository', () => {
    const app = mkdtempSync(join(tmpdir(), 'guida-'))
    expect(findGuideDir(app)).toBeNull()
    mkdirSync(join(app, 'guida'))
    writeFileSync(join(app, 'guida', 'GUIDA.md'), '# Guida')
    expect(findGuideDir(app)).toBe(join(app, 'guida'))
    // nel repository: ponte/controllo → ../../docs
    expect(findGuideDir(join(import.meta.dirname, '..'))).toBe(join(import.meta.dirname, '..', '..', '..', 'docs'))
  })

  it('accetta solo nomi di immagini semplici', () => {
    expect(guideImageName('/guida/immagini/regia-in-onda.png')).toBe('regia-in-onda.png')
    expect(guideImageName('/guida/immagini/foto.jpg')).toBe('foto.jpg')
    expect(guideImageName('/guida/immagini/../GUIDA.md')).toBeNull()
    expect(guideImageName('/guida/immagini/.nascosto.png')).toBeNull()
    expect(guideImageName('/guida/immagini/a/b.png')).toBeNull()
    expect(guideImageName('/guida/GUIDA.md')).toBeNull()
  })

  it('pagina con immagini dal server e link al repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guida-'))
    writeFileSync(join(dir, 'GUIDA.md'), '# Guida\n\n![In onda](immagini/a.png)\n\n[tecnica](../ponte/README.md)')
    const html = await guidePage(dir)
    expect(html).toContain('<img src="/guida/immagini/a.png"')
    expect(html).toContain('href="https://github.com/crybakk/radiosoftware/blob/main/ponte/README.md"')
    expect(html).toContain('Torna al pannello')
    expect(await guidePage(null)).toContain('non è installata')
  })
})
