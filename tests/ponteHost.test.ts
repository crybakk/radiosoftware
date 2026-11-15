import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { afterEach, describe, expect, it } from 'vitest'
import { PonteService } from '../src/main/ponte'
import { parsePonteHost, PonteClient, ponteControlBase, ponteHostProblem } from '../src/core/ponteClient'
import { remoteUrl } from '../src/core/remote'
import { DEFAULT_PONTE } from '../src/core/types'

const ffmpeg = ffmpegStatic as unknown as string
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

describe('indirizzo del ponte', () => {
  it('toglie spazi, barre finali e prefissi http(s):// e ws(s)://', () => {
    expect(parsePonteHost('  radio.esempio.it/ ')).toEqual({ hostname: 'radio.esempio.it', base: null, strayPort: null })
    expect(parsePonteHost('http://radio.esempio.it//').hostname).toBe('radio.esempio.it')
    expect(parsePonteHost('wss://radio.esempio.it:8443/').hostname).toBe('radio.esempio.it')
    expect(parsePonteHost('HTTPS://Radio.Esempio.it').hostname).toBe('radio.esempio.it')
  })

  it('stesso indirizzo per controllo, pannello remoto e SRT', () => {
    for (const h of ['radio.esempio.it', 'radio.esempio.it/', ' radio.esempio.it ']) {
      expect(ponteControlBase(h, 9080, false)).toBe('http://radio.esempio.it:9080')
      expect(remoteUrl(h, 9080, true)).toBe('wss://radio.esempio.it:9080/ws/regia')
    }
    // indirizzo completo: vale la porta scritta lì
    expect(ponteControlBase('https://radio.esempio.it:8443/', 9080, false)).toBe('https://radio.esempio.it:8443')
    expect(ponteControlBase('wss://radio.esempio.it:8443', 9080, false)).toBe('https://radio.esempio.it:8443')
    expect(remoteUrl('ws://radio.esempio.it:8080/', 9080, true)).toBe('ws://radio.esempio.it:8080/ws/regia')
    expect(remoteUrl('https://radio.esempio.it/ponte/', 9080, false)).toBe('wss://radio.esempio.it/ponte/ws/regia')
  })

  it('il client del ponte usa lo stesso indirizzo', () => {
    expect((new PonteClient('radio.esempio.it/', 9080, 't') as unknown as { base: string }).base).toBe('http://radio.esempio.it:9080')
  })

  it('":porta" senza http(s):// è ambigua: va segnalata prima di salvare', () => {
    expect(parsePonteHost('radio.esempio.it:9000')).toEqual({ hostname: 'radio.esempio.it', base: null, strayPort: 9000 })
    expect(ponteHostProblem('radio.esempio.it:9000')).toMatch(/senza ":porta"/)
    expect(ponteHostProblem('radio.esempio.it')).toBeNull()
    expect(ponteHostProblem('https://radio.esempio.it:8443')).toBeNull()
    expect(ponteHostProblem('')).toBeNull()
  })

  it('l\'invio SRT si collega anche con "127.0.0.1/" (barra finale)', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const rx = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', `srt://127.0.0.1:${port}?mode=listener`, '-f', 'null', '-'])
    cleanup.push(() => rx.kill('SIGKILL'))
    await new Promise((r) => setTimeout(r, 500))
    const svc = new PonteService({} as any, mkdtempSync(join(tmpdir(), 'regia-')), ffmpeg)
    cleanup.push(() => svc.stop())
    const frame = new Uint8Array(960 * 4)
    const feeder = setInterval(() => svc.writePcm(frame), 20)
    cleanup.push(() => clearInterval(feeder))
    svc.applySettings({ ...DEFAULT_PONTE, enabled: true, host: '127.0.0.1/', srtPort: port, remoteControl: false })
    svc.setCapture(true, 48000)
    const deadline = Date.now() + 6000
    while (Date.now() < deadline && svc.getStatus().uplink.state !== 'collegato') await new Promise((r) => setTimeout(r, 200))
    const s = svc.getStatus().uplink
    expect(s.state, s.message).toBe('collegato')
  }, 15000)
})
