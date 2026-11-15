import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import { afterEach, describe, expect, it } from 'vitest'
import { backoffSeconds, buildFfmpegArgs, explainError, Uplink, type UplinkStatus } from '../src/core/uplink'

const ffmpeg = ffmpegStatic as unknown as string
const cfg = { host: '127.0.0.1', srtPort: 0, passphrase: 'frase-segreta-di-prova', latencyMs: 300, bitrateKbps: 96 }

describe('argomenti di ffmpeg', () => {
  it('PCM in ingresso, Opus su SRT in uscita con latenza in microsecondi', () => {
    const args = buildFfmpegArgs({ ...cfg, srtPort: 9000 }, 48000)
    expect(args.join(' ')).toContain('-f s16le -ar 48000 -ac 2 -i pipe:0')
    expect(args).toContain('libopus')
    expect(args).toContain('96k')
    const url = new URL(args.at(-1)!)
    expect(url.protocol).toBe('srt:')
    expect(url.port).toBe('9000')
    expect(url.searchParams.get('latency')).toBe('300000')
    expect(url.searchParams.get('passphrase')).toBe('frase-segreta-di-prova')
  })
  it('senza frase segreta non la mette', () => {
    expect(buildFfmpegArgs({ ...cfg, passphrase: '' }, 44100).at(-1)).not.toContain('passphrase')
  })
})

describe('messaggi di errore', () => {
  it('traduce gli errori comuni', () => {
    expect(explainError('Connection setup failure: connection timed out')).toBe('Il ponte non risponde')
    expect(explainError('Failed to resolve hostname ponte.example')).toBe('Indirizzo del ponte non trovato')
    expect(explainError('')).toBe('Collegamento interrotto')
  })
  it('attese crescenti fino a 30 secondi', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(backoffSeconds)).toEqual([2, 4, 8, 16, 30, 30, 30])
  })
})

describe('collegamento reale con un ricevitore SRT', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    for (const c of cleanup.splice(0)) c()
  })

  function listener(port: number) {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', `srt://127.0.0.1:${port}?mode=listener&passphrase=${cfg.passphrase}`, '-f', 'null', '-'])
    cleanup.push(() => p.kill('SIGKILL'))
    return p
  }

  function waitFor(up: Uplink, pred: (s: UplinkStatus) => boolean, ms: number): Promise<UplinkStatus> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout, stato ${JSON.stringify(up.getStatus())}`)), ms)
      const off = up.onStatus((s) => {
        if (pred(s)) {
          clearTimeout(t)
          off()
          resolve(s)
        }
      })
    })
  }

  it('si collega, poi se il ponte cade passa in riconnessione', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const rx = listener(port)
    await new Promise((r) => setTimeout(r, 500))
    const up = new Uplink(ffmpeg)
    cleanup.push(() => up.stop())
    // 20 ms di tono a 48 kHz, stereo
    const frame = new Int16Array(960 * 2)
    for (let i = 0; i < 960; i++) frame[2 * i] = frame[2 * i + 1] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000))
    const feeder = setInterval(() => up.write(new Uint8Array(frame.buffer)), 20)
    cleanup.push(() => clearInterval(feeder))
    up.start({ ...cfg, srtPort: port }, 48000)
    const on = await waitFor(up, (s) => s.state === 'collegato', 15000)
    expect(on.connectedSince).not.toBeNull()
    rx.kill('SIGKILL')
    const off = await waitFor(up, (s) => s.state === 'riconnessione', 20000)
    expect(off.retryIn).toBeGreaterThan(0)
    up.stop()
    expect(up.getStatus().state).toBe('spento')
  }, 45000)
})
