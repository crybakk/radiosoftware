import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ffmpegArgs, parseVideoStream, VideoLive, type ChildLike } from './video.ts'

class FakeChild implements ChildLike {
  private dataCb: ((d: Buffer) => void) | null = null
  private exitCb: ((code: number | null) => void) | null = null
  killed = false
  stderr = { on: (_ev: 'data', cb: (d: Buffer) => void) => (this.dataCb = cb) }
  on(_ev: 'exit', cb: (code: number | null) => void): void {
    this.exitCb = cb
  }
  kill(): void {
    this.killed = true
    this.exitCb?.(null)
  }
  line(s: string): void {
    this.dataCb?.(Buffer.from(`${s}\n`))
  }
  exit(code: number): void {
    this.exitCb?.(code)
  }
}

function setup(withLogo = true) {
  const dir = mkdtempSync(join(tmpdir(), 'video-'))
  const logo = join(dir, 'logo.png')
  if (withLogo) writeFileSync(logo, 'x')
  const children: { args: string[]; child: FakeChild }[] = []
  const v = new VideoLive({
    file: join(dir, 'dirette-video.json'),
    logo: () => (withLogo ? logo : null),
    audioUrl: 'http://liquidsoap:8093/programma',
    obsPort: 9020,
    obsPassphrase: 'segreto1234',
    spawn: (_cmd, args) => {
      const child = new FakeChild()
      children.push({ args, child })
      return child
    }
  })
  return { v, children, dir }
}

describe('dirette video', () => {
  it('logo: ricodifica a 720p e manda alle destinazioni scelte', () => {
    const a = ffmpegArgs({ source: 'logo', logo: '/data/logo.png', obsUrl: '', audioUrl: 'http://x/p', delayMs: 0, outputs: ['rtmp://a/k1', 'rtmps://b/k2'] })
    expect(a.join(' ')).toContain('scale=1280:720')
    expect(a).toContain('libx264')
    expect(a.at(-1)).toBe('[f=flv:onfail=ignore]rtmp://a/k1|[f=flv:onfail=ignore]rtmps://b/k2')
  })

  it('OBS: video inoltrato senza ricodifica, ritardo sull\'audio o sul video', () => {
    const a = ffmpegArgs({ source: 'obs', logo: '', obsUrl: 'srt://0.0.0.0:9020?mode=listener', audioUrl: 'http://x/p', delayMs: 500, outputs: ['rtmp://a/k'] })
    expect(a.join(' ')).toContain('-c:v copy')
    expect(a.indexOf('-itsoffset')).toBeGreaterThan(a.indexOf('srt://0.0.0.0:9020?mode=listener'))
    const b = ffmpegArgs({ source: 'obs', logo: '', obsUrl: 'srt://0.0.0.0:9020?mode=listener', audioUrl: 'http://x/p', delayMs: -300, outputs: ['rtmp://a/k'] })
    expect(b.indexOf('-itsoffset')).toBeLessThan(b.indexOf('srt://0.0.0.0:9020?mode=listener'))
    expect(b[b.indexOf('-itsoffset') + 1]).toBe('0.300')
  })

  it('legge risoluzione e codec dalle righe di ffmpeg', () => {
    expect(parseVideoStream('Stream #0:0: Video: h264 (High), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps')).toEqual({ codec: 'h264', width: 1920, height: 1080 })
    expect(parseVideoStream('Stream #0:1: Audio: aac (LC), 48000 Hz, stereo')).toBeNull()
  })

  it('non parte senza chiavi o senza logo', () => {
    const { v } = setup(false)
    expect(() => v.run({ type: 'start', source: 'logo', destinations: ['youtube'] }, 'anna')).toThrow(/chiave di YouTube/)
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl' }, 'admin')
    expect(() => v.run({ type: 'start', source: 'logo', destinations: ['youtube'] }, 'anna')).toThrow(/logo/)
    expect(() => v.run({ type: 'start', source: 'logo', destinations: [] }, 'anna')).toThrow(/destinazione/)
  })

  it('le chiavi restano sul ponte e lo stato non le mostra', () => {
    const { v } = setup()
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl', facebookKey: 'FB-123-0-Abc' }, 'admin')
    const st = JSON.stringify(v.status())
    expect(st).not.toContain('abcd-efgh')
    expect(v.status()).toMatchObject({ youtube: true, facebook: true })
    expect(() => v.run({ type: 'config', youtubeKey: 'a|b c' }, 'admin')).toThrow(/non valida/)
  })

  it('avvio con logo, in onda al primo segnale di avanzamento, stop', () => {
    const { v, children } = setup()
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl', facebookKey: 'FB-123-0-Abc' }, 'admin')
    v.run({ type: 'start', source: 'logo', destinations: ['youtube', 'facebook'] }, 'anna')
    expect(v.status().state).toBe('avvio')
    const out = children[0].args.at(-1) ?? ''
    expect(out).toContain('rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl')
    expect(out).toContain('rtmps://live-api-s.facebook.com:443/rtmp/FB-123-0-Abc')
    children[0].child.line('frame=  150 fps= 15 q=-1.0 size=    1024kB time=00:00:10.00 bitrate= 838.9kbits/s speed=   1x')
    expect(v.status()).toMatchObject({ state: 'in_onda', by: 'anna' })
    expect(() => v.run({ type: 'start', source: 'logo', destinations: ['youtube'] }, 'anna')).toThrow(/già accesa/)
    v.run({ type: 'stop' }, 'anna')
    expect(children[0].child.killed).toBe(true)
    expect(v.status().state).toBe('spenta')
  })

  it('OBS oltre 720p: si ferma con un messaggio chiaro', () => {
    const { v, children } = setup()
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl' }, 'admin')
    v.run({ type: 'start', source: 'obs', destinations: ['youtube'] }, 'anna')
    expect(v.status().state).toBe('attesa_obs')
    expect(children[0].args.join(' ')).toContain('srt://0.0.0.0:9020?mode=listener&latency=200000&passphrase=segreto1234')
    children[0].child.line('  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 30 fps')
    expect(v.status().state).toBe('errore')
    expect(v.status().error).toMatch(/1280x720/)
    expect(children[0].child.killed).toBe(true)
  })

  it('se ffmpeg si ferma riprova, poi si arrende e avvisa', async () => {
    const { v, children } = setup()
    const alerts: string[] = []
    v.onAlert = (t) => alerts.push(t)
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl' }, 'admin')
    const timers: (() => void)[] = []
    const orig = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void) => {
      timers.push(fn)
      return 0
    }) as unknown as typeof setTimeout
    try {
      v.run({ type: 'start', source: 'logo', destinations: ['youtube'] }, 'anna')
      children[0].child.line('frame=1 fps=0')
      for (let i = 0; i < 6; i++) {
        children.at(-1)?.child.line('Connection refused')
        children.at(-1)?.child.exit(1)
        timers.shift()?.()
      }
    } finally {
      globalThis.setTimeout = orig
    }
    expect(v.status().state).toBe('errore')
    expect(alerts[0]).toMatch(/interrotta/)
    expect(alerts.at(-1)).toMatch(/fermata/)
  })
})
