import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ffmpegArgs, parseVideoStream, VideoLive, type ChildLike } from './video.ts'

class FakeChild implements ChildLike {
  private dataCb: ((d: Buffer) => void) | null = null
  private exitCbs: ((code: number | null) => void)[] = []
  private errorCbs: ((e: Error) => void)[] = []
  killed = false
  signals: string[] = []
  /** Un ffmpeg bloccato che non esce con SIGTERM. */
  stubborn = false
  stderr = { on: (_ev: 'data', cb: (d: Buffer) => void) => (this.dataCb = cb) }
  on(ev: 'exit' | 'error', cb: (x: any) => void): void {
    if (ev === 'exit') this.exitCbs.push(cb)
    else this.errorCbs.push(cb)
  }
  kill(sig: string = 'SIGTERM'): void {
    this.signals.push(sig)
    if (this.stubborn && sig !== 'SIGKILL') return
    this.killed = true
    this.exit(null)
  }
  line(s: string): void {
    this.dataCb?.(Buffer.from(`${s}\n`))
  }
  exit(code: number | null): void {
    for (const cb of this.exitCbs) cb(code)
  }
  fail(e: Error): void {
    for (const cb of this.errorCbs) cb(e)
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

describe('dirette video: errori, chiavi e ripartenze', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gli errori di ffmpeg non mostrano chiavi né passphrase a chi guarda il pannello', () => {
    const { v, children } = setup()
    const logs: string[] = []
    const alerts: string[] = []
    v.onLog = (l) => logs.push(l)
    v.onAlert = (a) => alerts.push(a)
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl', facebookKey: 'FB-123-0-Abc' }, 'admin')
    vi.useFakeTimers()
    v.run({ type: 'start', source: 'obs', destinations: ['youtube', 'facebook'] }, 'anna')
    const c = children[0].child
    c.line('[tee @ 0x55d] Slave \'[f=flv:onfail=ignore]rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl\': Input/output error')
    c.line('srt://0.0.0.0:9020?mode=listener&latency=200000&passphrase=segreto1234: Connection refused')
    c.line('[flv @ 0x1] rtmps://live-api-s.facebook.com:443/rtmp/FB-123-0-Abc: Broken pipe')
    c.exit(1)
    const visible = JSON.stringify([v.status(), logs, alerts])
    expect(visible).not.toContain('abcd-efgh-ijkl')
    expect(visible).not.toContain('FB-123-0-Abc')
    expect(visible).not.toContain('segreto1234')
    expect(v.status().error).toContain('rtmps://live-api-s.facebook.com:443/rtmp/***')
    v.run({ type: 'stop' }, 'anna')
  })

  it('ffmpeg che non si avvia non fa cadere il servizio: riprova e poi si ferma', () => {
    const { v, children } = setup()
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl' }, 'admin')
    vi.useFakeTimers()
    v.run({ type: 'start', source: 'logo', destinations: ['youtube'] }, 'anna')
    for (let i = 0; i < 6; i++) {
      children.at(-1)!.child.fail(new Error('spawn ffmpeg ENOENT'))
      vi.advanceTimersByTime(5000)
    }
    expect(children).toHaveLength(6)
    expect(v.status().state).toBe('errore')
    expect(v.status().error).toMatch(/non si avvia/)
  })

  it('se cade sempre pochi secondi dopo essere andata in onda non riparte all\'infinito', () => {
    const { v, children } = setup()
    const alerts: string[] = []
    v.onAlert = (a) => alerts.push(a)
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl' }, 'admin')
    vi.useFakeTimers()
    v.run({ type: 'start', source: 'logo', destinations: ['youtube'] }, 'anna')
    for (let i = 0; i < 20 && v.status().state !== 'errore'; i++) {
      const c = children.at(-1)!.child
      c.line('frame=  75 fps= 15 q=-1.0 size=  512kB time=00:00:05.00 bitrate= 838.9kbits/s speed=1x')
      vi.advanceTimersByTime(10_000)
      c.exit(1)
      vi.advanceTimersByTime(5000)
    }
    expect(v.status().state).toBe('errore')
    expect(children).toHaveLength(6)
    expect(alerts.at(-1)).toMatch(/fermata/)
  })

  it('dopo un po\' in onda una caduta ricomincia i tentativi da capo', () => {
    const { v, children } = setup()
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl' }, 'admin')
    let t = Date.parse('2026-11-15T10:00:00Z')
    ;(v as any).now = () => t
    vi.useFakeTimers()
    v.run({ type: 'start', source: 'logo', destinations: ['youtube'] }, 'anna')
    for (let i = 0; i < 8; i++) {
      const c = children.at(-1)!.child
      c.line('frame=  75 fps= 15')
      t += 120_000
      c.exit(1)
      vi.advanceTimersByTime(5000)
    }
    expect(v.status().state).not.toBe('errore')
    v.run({ type: 'stop' }, 'anna')
  })

  it('ffmpeg che non esce con SIGTERM viene chiuso con SIGKILL', () => {
    const { v, children } = setup()
    v.run({ type: 'config', youtubeKey: 'abcd-efgh-ijkl' }, 'admin')
    vi.useFakeTimers()
    v.run({ type: 'start', source: 'logo', destinations: ['youtube'] }, 'anna')
    const c = children[0].child
    c.stubborn = true
    v.run({ type: 'stop' }, 'anna')
    expect(c.signals).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(5000)
    expect(c.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
