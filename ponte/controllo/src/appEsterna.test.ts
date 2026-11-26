import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AppEsterna, componiTitolo, ffmpegArgs, pulisciTesto, type AppEsternaDeps } from './appEsterna.ts'
import type { EsternaStatus } from './protocol.ts'

class FakePeer {
  sent: unknown[] = []
  closed: { code?: number; reason?: string } | null = null
  send(d: string): void {
    this.sent.push(JSON.parse(d))
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
  last(t: string): any {
    return [...this.sent].reverse().find((m) => (m as { t: string }).t === t)
  }
}

class FakeProc extends EventEmitter {
  written: Buffer[] = []
  ended = false
  killed = false
  stdin = Object.assign(new EventEmitter(), {
    write: (b: Buffer, cb?: () => void) => {
      this.written.push(b)
      cb?.()
      return true
    },
    end: () => {
      this.ended = true
    }
  })
  kill(): void {
    this.killed = true
  }
}

const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])

function setup(extra: Partial<AppEsternaDeps> = {}) {
  const lq: { path: string; body: any }[] = []
  const onAir: [boolean, string, string][] = []
  const titles: string[] = []
  let status: EsternaStatus | null = null
  const procs: { args: string[]; p: FakeProc }[] = []
  const app = new AppEsterna({
    lq: async (path, body) => {
      lq.push({ path, body })
      return true
    },
    icecastUrl: 'icecast://source:pw@liquidsoap:9011/app',
    programTitle: (id) => (id === 'p1' ? 'Mattina' : null),
    stationName: 'Radio Prova',
    onAir: (on, user, t) => onAir.push([on, user, t]),
    onTitle: (t) => titles.push(t),
    onChange: (s) => (status = s),
    spawn: (_cmd, args) => {
      const p = new FakeProc()
      procs.push({ args, p })
      return p as never
    },
    log: () => {},
    offDelayMs: 50,
    ...extra
  })
  return { app, lq, onAir, titles, procs, status: () => status }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('app Radio Esterna sul server', () => {
  it('titolo in onda: programma e riga libera', () => {
    expect(componiTitolo('Mattina', 'Dalla piazza')).toBe('Mattina – Dalla piazza')
    expect(componiTitolo(null, 'Dalla piazza')).toBe('Dalla piazza')
    expect(componiTitolo('Mattina', '')).toBe('Mattina')
    expect(componiTitolo(null, '')).toBe('In diretta')
    expect(pulisciTesto('  a\nb\u0007c  ')).toBe('a b c')
    expect(pulisciTesto('x'.repeat(500))).toHaveLength(200)
  })

  it("ffmpeg rimette l'Opus in Ogg senza ricodificarlo", () => {
    const a = ffmpegArgs('icecast://x')
    expect(a).toContain('copy')
    expect(a.at(-1)).toBe('icecast://x')
    expect(a.join(' ')).toContain('-f webm -i pipe:0')
  })

  it("collegata è fuori onda; IN ONDA conta solo quando l'audio arriva", async () => {
    const t = setup()
    const peer = new FakePeer()
    const h = t.app.attach(peer, 'Mario')
    expect(peer.last('benvenuto')).toMatchObject({ user: 'Mario', stazione: 'Radio Prova' })
    expect(t.status()).toMatchObject({ collegata: true, inOnda: false, user: 'Mario' })
    h.message(Buffer.from(JSON.stringify({ t: 'meta', programId: 'p1', testo: 'Dalla piazza' })), false)
    await flush()
    expect(t.lq.at(-1)).toEqual({ path: '/app/metadata', body: { artist: '', title: 'Mattina – Dalla piazza' } })
    h.message(Buffer.from(JSON.stringify({ t: 'onda', on: true })), false)
    await flush()
    expect(t.lq.some((x) => x.path === '/app/onda' && x.body.on === true)).toBe(true)
    // l'audio non arriva ancora: non è davvero in onda
    expect(t.onAir).toEqual([])
    expect(t.status()).toMatchObject({ inOnda: true, inOndaDavvero: false })
    t.app.setAudio(true)
    expect(t.onAir).toEqual([[true, 'Mario', 'Mattina – Dalla piazza']])
    expect(t.status()?.inOndaDavvero).toBe(true)
    h.message(Buffer.from(JSON.stringify({ t: 'onda', on: false })), false)
    await flush()
    expect(t.onAir.at(-1)).toEqual([false, 'Mario', 'Mattina – Dalla piazza'])
    expect(t.status()).toMatchObject({ inOnda: false, since: null })
  })

  it('una sola app alla volta; la stessa persona prende il posto della connessione vecchia', () => {
    const t = setup()
    const a = new FakePeer()
    t.app.attach(a, 'Mario')
    const b = new FakePeer()
    t.app.attach(b, 'Luisa')
    expect(b.closed?.code).toBe(4009)
    expect(b.last('errore').messaggio).toContain('Mario')
    const c = new FakePeer()
    t.app.attach(c, 'mario')
    expect(a.closed?.code).toBe(4000)
    expect(c.closed).toBeNull()
  })

  it("l'audio parte solo dall'inizio di un file WebM e va a ffmpeg", () => {
    const t = setup()
    const h = t.app.attach(new FakePeer(), 'Mario')
    h.message(Buffer.from([1, 2, 3, 4, 5]), true)
    expect(t.procs).toHaveLength(0)
    h.message(EBML, true)
    h.message(Buffer.from([9, 9]), true)
    expect(t.procs).toHaveLength(1)
    expect(t.procs[0].args.at(-1)).toBe('icecast://source:pw@liquidsoap:9011/app')
    expect(t.procs[0].p.written).toHaveLength(2)
    h.close()
    expect(t.procs[0].p.ended).toBe(true)
  })

  it('senza ingresso sul server (password interna vuota) rifiuta con un messaggio chiaro', () => {
    const t = setup({ icecastUrl: null })
    const p = new FakePeer()
    t.app.attach(p, 'Mario')
    expect(p.closed?.code).toBe(4010)
    expect(p.last('errore').messaggio).toContain('aggiornalo')
  })

  it("rete caduta mentre è in onda: resta in onda un minuto; se l'app torna resta in onda", async () => {
    const t = setup()
    const h = t.app.attach(new FakePeer(), 'Mario')
    h.message(Buffer.from(JSON.stringify({ t: 'onda', on: true })), false)
    await flush()
    h.close()
    expect(t.status()).toMatchObject({ collegata: false, inOnda: true, user: 'Mario' })
    const h2 = t.app.attach(new FakePeer(), 'Mario')
    h2.message(Buffer.from(JSON.stringify({ t: 'hello', inOnda: true })), false)
    await new Promise((r) => setTimeout(r, 80))
    expect(t.status()?.inOnda).toBe(true)
    // ora sparisce davvero: dopo l'attesa va fuori onda
    h2.close()
    await new Promise((r) => setTimeout(r, 80))
    expect(t.status()?.inOnda).toBe(false)
    expect(t.lq.at(-1)).toEqual({ path: '/app/onda', body: { on: false } })
  })

  it('brano riconosciuto: titolo e artista per la sua durata, poi torna il programma', async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      const h = t.app.attach(new FakePeer(), 'Mario')
      h.message(Buffer.from(JSON.stringify({ t: 'meta', programId: 'p1', testo: '' })), false)
      h.message(Buffer.from(JSON.stringify({ t: 'onda', on: true })), false)
      await vi.advanceTimersByTimeAsync(0)
      t.app.setAudio(true)
      t.app.brano('Artista', 'Canzone', 60)
      await vi.advanceTimersByTimeAsync(0)
      expect(t.lq.at(-1)).toEqual({ path: '/app/metadata', body: { artist: 'Artista', title: 'Canzone' } })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(t.lq.at(-1)).toEqual({ path: '/app/metadata', body: { artist: '', title: 'Mattina' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('i token di ascolto valgono solo con l\'app collegata', () => {
    const t = setup()
    const p = new FakePeer()
    const h = t.app.attach(p, 'Mario')
    const ritorno = p.last('benvenuto').ritorno as string
    const ascolto = t.status()?.ascolto as string
    expect(t.app.validRitorno(ritorno)).toBe(true)
    expect(t.app.validAscolto(ascolto)).toBe(true)
    expect(t.app.validAscolto('sbagliato')).toBe(false)
    h.close()
    expect(t.app.validRitorno(ritorno)).toBe(false)
    expect(t.app.validAscolto(ascolto)).toBe(false)
  })
})

describe('app Radio Esterna in WebRTC (26/11/2026)', () => {
  function rtcSetup() {
    let now = 1_000_000
    const sessions: { sdp: string; h: { onVoice(p: Buffer): void; onEnd(): void }; returned: Buffer[]; closed: boolean }[] = []
    const toLq: Buffer[] = []
    const audio: boolean[] = []
    const t = setup({
      now: () => now,
      rtc: {
        factory: async (sdp, h) => {
          const s = { sdp, h, returned: [] as Buffer[], closed: false }
          sessions.push(s)
          return { answer: `risposta:${sdp}`, sendReturn: (p: Buffer) => s.returned.push(p), close: () => (s.closed = true) }
        },
        codec: null,
        sendAudio: (p) => toLq.push(p),
        timer: false
      },
      onAudio: (on) => audio.push(on)
    })
    return { ...t, sessions, toLq, audio, avanza: (ms: number) => (now += ms) }
  }
  const pkt = (seq: number) => {
    const b = Buffer.alloc(20)
    b[0] = 0x80
    b[1] = 111
    b.writeUInt16BE(seq, 2)
    b.writeUInt32BE(seq * 960, 4)
    b.writeUInt32BE(99, 8)
    return b
  }

  it('offerta → risposta; la voce va a Liquidsoap, il ritorno torna all\'app, la linea si misura', async () => {
    const t = rtcSetup()
    const peer = new FakePeer()
    const h = t.app.attach(peer, 'Mario')
    h.message(Buffer.from(JSON.stringify({ t: 'rtc-offerta', sdp: 'offerta' })), false)
    await flush()
    expect(peer.last('rtc-risposta')).toEqual({ t: 'rtc-risposta', sdp: 'risposta:offerta' })
    expect(t.status()).toMatchObject({ via: 'webrtc' })
    const s = t.sessions[0]
    // 3 secondi di audio regolare
    for (let i = 0; i < 150; i++) {
      t.avanza(20)
      s.h.onVoice(pkt(i))
      if (i % 50 === 49) (t.app as any).ricevitore.tick()
    }
    expect(t.toLq.length).toBe(150)
    expect(t.status()).toMatchObject({ audio: true, linea: { livello: 'buona' } })
    expect(t.audio).toEqual([true])
    t.app.ritornoRtc(Buffer.from([1, 2, 3]))
    expect(s.returned).toHaveLength(1)
    // il WebRTC cade: torna l'HTTPS, l'audio non c'è più
    s.h.onEnd()
    expect(s.closed).toBe(true)
    expect(t.status()).toMatchObject({ via: 'https', audio: false })
    expect(t.audio).toEqual([true, false])
  })

  it('con WebRTC attivo i pezzi HTTPS si ignorano e il flusso HTTPS si chiude', async () => {
    const t = rtcSetup()
    const peer = new FakePeer()
    const h = t.app.attach(peer, 'Mario')
    h.message(EBML, true)
    expect(t.procs).toHaveLength(1)
    h.message(Buffer.from(JSON.stringify({ t: 'rtc-offerta', sdp: 'o' })), false)
    await flush()
    for (let i = 0; i < 120; i++) {
      t.avanza(20)
      t.sessions[0].h.onVoice(pkt(i))
      if (i % 50 === 49) (t.app as any).ricevitore.tick()
    }
    expect(t.procs[0].p.ended).toBe(true)
    h.message(EBML, true)
    expect(t.procs).toHaveLength(1)
  })

  it('server senza WebRTC: l\'app riceve un errore e resta in HTTPS', async () => {
    const t = setup()
    const peer = new FakePeer()
    const h = t.app.attach(peer, 'Mario')
    h.message(Buffer.from(JSON.stringify({ t: 'rtc-offerta', sdp: 'o' })), false)
    await flush()
    expect(peer.last('rtc-errore')).toBeTruthy()
    expect(t.status()).toMatchObject({ via: 'https' })
  })

  it('app chiusa: si chiude anche il WebRTC', async () => {
    const t = rtcSetup()
    const peer = new FakePeer()
    const h = t.app.attach(peer, 'Mario')
    h.message(Buffer.from(JSON.stringify({ t: 'rtc-offerta', sdp: 'o' })), false)
    await flush()
    h.close()
    expect(t.sessions[0].closed).toBe(true)
  })
})

describe('linea in HTTPS', async () => {
  const { LineaArrivi } = await import('./ricevitore.ts')
  it('pezzi regolari = buona; pause lunghe = debole o pessima; niente = assente', () => {
    const l = new LineaArrivi()
    for (let t = 0; t <= 5000; t += 250) l.push(t)
    expect(l.stato(5000).livello).toBe('buona')
    const m = new LineaArrivi()
    for (let t = 0; t <= 6000; t += 2000) m.push(t)
    expect(m.stato(6000).livello).toBe('pessima')
    const d = new LineaArrivi()
    for (let t = 0; t <= 5000; t += 250) if (t < 2500 || t > 3000) d.push(t)
    expect(d.stato(5000)).toMatchObject({ livello: 'debole', frase: expect.stringContaining('intero') })
    expect(d.stato(8000).livello).toBe('assente')
  })
})
