import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filtroIcona, IconeApp, manifest, nomeCorto, nomeIcona } from './installabile.ts'

const PANNELLO = join(dirname(fileURLToPath(import.meta.url)), '..', 'pannello')
const lato = (b: Buffer): string => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`
let ffmpeg = true
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  ffmpeg = false
}

describe('app del player', () => {
  it('nome corto sotto l\'icona senza parole tagliate', () => {
    expect(nomeCorto('Radio Attiva Informazione')).toBe('Radio Attiva')
    expect(nomeCorto('Radio')).toBe('Radio')
    expect(nomeCorto('Radioattivainformazione')).toBe('Radioattivai')
    expect(nomeCorto('  ')).toBe('Radio')
  })

  it('manifest: le icone cambiano indirizzo quando cambia il logo', () => {
    const m = manifest('Radio X', '', 'abc') as { icons: { src: string; purpose: string }[]; description: string }
    expect(m.icons.every((i) => i.src.endsWith('?v=abc'))).toBe(true)
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true)
    expect(m.description).toBe('Ascolta Radio X in diretta')
  })

  it('indirizzi delle icone', () => {
    expect(nomeIcona('/icona-192.png')).toBe('icona-192.png')
    expect(nomeIcona('/apple-touch-icon-precomposed.png')).toBe('apple-touch-icon.png')
    expect(nomeIcona('/../etc/passwd')).toBeNull()
    expect(nomeIcona('/constructor')).toBeNull()
    expect(filtroIcona(512, 0.5)).toContain('scale=256:256')
  })

  it('senza logo: icone di base', async () => {
    const a = new IconeApp({ logo: () => null, cartella: mkdtempSync(join(tmpdir(), 'icone-')), pannello: PANNELLO })
    expect(await a.versione()).toBe('base')
    expect(await a.icona('icona-512.png')).toEqual(readFileSync(join(PANNELLO, 'icona-radio-512.png')))
    expect(await a.icona('niente.png')).toBeNull()
  })

  it('logo che ffmpeg non sa leggere: icone di base, senza errori', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icone-'))
    const logo = join(dir, 'logo.png')
    writeFileSync(logo, 'non è un\'immagine')
    const a = new IconeApp({ logo: () => logo, cartella: join(dir, 'out'), pannello: PANNELLO, ffmpeg: ffmpeg ? 'ffmpeg' : '/nessun/ffmpeg' })
    expect(await a.icona('icona-192.png')).toEqual(readFileSync(join(PANNELLO, 'icona-radio-192.png')))
  })

  it.skipIf(!ffmpeg)('con il logo: icone quadrate fatte dal logo, delle misure giuste', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icone-'))
    const logo = join(dir, 'logo.png')
    // logo rettangolare 400x100
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=yellow:s=400x100', '-frames:v', '1', logo])
    const a = new IconeApp({ logo: () => logo, cartella: join(dir, 'out'), pannello: PANNELLO })
    expect(await a.versione()).not.toBe('base')
    const [i512, i192, apple] = await Promise.all([a.icona('icona-512.png'), a.icona('icona-192.png'), a.icona('apple-touch-icon.png')])
    expect(lato(i512!)).toBe('512x512')
    expect(lato(i192!)).toBe('192x192')
    expect(lato(apple!)).toBe('180x180')
    expect(i512).not.toEqual(readFileSync(join(PANNELLO, 'icona-radio-512.png')))
  })
})
