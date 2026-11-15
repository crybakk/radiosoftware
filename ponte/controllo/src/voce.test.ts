import { describe, expect, it } from 'vitest'
import { VoiceHub, type RtcSessionHandlers } from './voce.ts'
import { Relay, type Peer } from './relay.ts'

function setup(liquidsoapOk = true) {
  const sentVoice: Buffer[] = []
  const returned: Buffer[] = []
  const onAirCalls: boolean[] = []
  let handlers: RtcSessionHandlers | null = null
  let closed = 0
  const hub = new VoiceHub({
    factory: async (sdp, h) => {
      if (sdp === 'rotta') throw new Error('offerta del browser non valida')
      handlers = h
      return { answer: `risposta:${sdp}`, close: () => closed++, sendReturn: (p) => returned.push(p) }
    },
    sendVoice: (p) => sentVoice.push(p),
    setOnAir: async (on) => {
      onAirCalls.push(on)
      return liquidsoapOk
    }
  })
  return { hub, sentVoice, returned, onAirCalls, h: () => handlers!, closed: () => closed }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const rtp = Buffer.from([0x80, 0x6f, 0, 1, 0, 0, 0, 0, 0, 0, 0, 9, 1, 2, 3])

describe('microfono remoto', () => {
  it('apre, va in onda, inoltra la voce e il ritorno, si chiude da solo se cade', async () => {
    const t = setup()
    const a = {}
    expect(await t.hub.open(a, 'cristian', 'offerta')).toBe('risposta:offerta')
    expect(t.hub.status()).toEqual({ user: 'cristian', onAir: false })
    t.h().onVoice(rtp)
    expect(t.sentVoice).toHaveLength(1)
    t.hub.sendReturn(rtp)
    expect(t.returned).toHaveLength(1)
    await t.hub.setMic(a, true)
    expect(t.hub.status().onAir).toBe(true)
    // la connessione cade: microfono fuori onda
    t.h().onEnd()
    expect(t.hub.status()).toEqual({ user: null, onAir: false })
    expect(t.onAirCalls).toEqual([true, false])
  })

  it('un solo microfono alla volta; un altro non può comandarlo', async () => {
    const t = setup()
    const a = {}
    const b = {}
    await t.hub.open(a, 'cristian', 'x')
    await expect(t.hub.open(b, 'marco', 'y')).rejects.toThrow(/già usato da cristian/)
    await expect(t.hub.setMic(b, true)).rejects.toThrow(/apri prima/)
    t.hub.close(b)
    expect(t.hub.status().user).toBe('cristian')
    t.hub.close(a)
    expect(t.closed()).toBe(1)
    expect(await t.hub.open(b, 'marco', 'y')).toBe('risposta:y')
  })

  it('offerta non valida o mixer che non risponde', async () => {
    const t = setup(false)
    const a = {}
    await expect(t.hub.open(a, 'cristian', 'rotta')).rejects.toThrow(/non valida/)
    expect(t.hub.status().user).toBeNull()
    await t.hub.open(a, 'cristian', 'ok')
    await expect(t.hub.setMic(a, true)).rejects.toThrow(/non risponde/)
    expect(t.hub.status().onAir).toBe(false)
  })
})

describe('microfono remoto: corse e reti che cadono', () => {
  function lento() {
    const sessions: { closed: boolean }[] = []
    const pendingOpen: (() => void)[] = []
    const mixer: { on: boolean; done: (ok: boolean) => void }[] = []
    const liquidsoap: boolean[] = []
    const hub = new VoiceHub({
      factory: (sdp) =>
        new Promise((resolve) => {
          const s = { closed: false }
          sessions.push(s)
          pendingOpen.push(() => resolve({ answer: sdp, close: () => (s.closed = true), sendReturn: () => {} }))
        }),
      sendVoice: () => {},
      setOnAir: (on) =>
        new Promise((resolve) => {
          liquidsoap.push(on)
          mixer.push({ on, done: resolve })
        })
    })
    return { hub, sessions, pendingOpen, mixer, liquidsoap }
  }

  it('due offerte insieme dallo stesso pannello: nessuna connessione resta aperta senza nessuno', async () => {
    const t = lento()
    const a = {}
    const first = t.hub.open(a, 'cristian', 'uno')
    await expect(t.hub.open(a, 'cristian', 'due')).rejects.toThrow(/sta già aprendo/)
    t.pendingOpen.forEach((f) => f())
    expect(await first).toBe('uno')
    expect(t.sessions).toHaveLength(1)
    t.hub.close(a)
    expect(t.sessions.every((s) => s.closed)).toBe(true)
  })

  it('il pannello cade mentre il mixer mette in onda: la voce viene tolta', async () => {
    const t = lento()
    const a = {}
    const o = t.hub.open(a, 'cristian', 'x')
    t.pendingOpen[0]()
    await o
    const on = t.hub.setMic(a, true)
    t.hub.close(a)
    t.mixer[0].done(true)
    await expect(on).rejects.toThrow(/chiuso/)
    await flush()
    t.mixer[1]?.done(true)
    expect(t.liquidsoap).toEqual([true, false])
    expect(t.hub.status()).toEqual({ user: null, onAir: false })
  })

  it('in onda e fuori onda insieme: il mixer li riceve in ordine e lo stato è l\'ultimo comando', async () => {
    const t = lento()
    const a = {}
    const o = t.hub.open(a, 'cristian', 'x')
    t.pendingOpen[0]()
    await o
    const on = t.hub.setMic(a, true)
    const off = t.hub.setMic(a, false)
    await flush()
    // il secondo comando parte solo quando il primo ha risposto
    expect(t.liquidsoap).toEqual([true])
    t.mixer[0].done(true)
    await flush()
    expect(t.liquidsoap).toEqual([true, false])
    t.mixer[1].done(true)
    await Promise.all([on, off])
    expect(t.hub.status().onAir).toBe(false)
  })
})

class FakePeer implements Peer {
  sent: any[] = []
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close() {}
  last(t: string) {
    return [...this.sent].reverse().find((m) => m.t === t)
  }
}

describe('microfono dal pannello', () => {
  it('permessi, risposte e chiusura del pannello', async () => {
    const t = setup()
    const r = new Relay('tok')
    r.voice = t.hub
    t.hub.onChange = (m) => r.setMic(m)
    const ospite = new FakePeer()
    const og = r.attachPanel(ospite, { name: 'ospite', role: 'ospite' })
    expect(ospite.last('mic')).toEqual({ t: 'mic', mic: { user: null, onAir: false } })
    og.message(JSON.stringify({ t: 'rtc-offer', id: '1', sdp: 'x' }))
    await flush()
    expect(ospite.last('reply')).toMatchObject({ id: '1', ok: false, error: expect.stringMatching(/ruolo/) })

    const cond = new FakePeer()
    const ch = r.attachPanel(cond, { name: 'cristian', role: 'conduttore' })
    ch.message(JSON.stringify({ t: 'rtc-offer', id: '2', sdp: 'x' }))
    await flush()
    expect(cond.last('reply')).toEqual({ t: 'reply', id: '2', ok: true, data: { sdp: 'risposta:x' } })
    ch.message(JSON.stringify({ t: 'mic', id: '3', on: true }))
    await flush()
    expect(cond.last('reply')).toMatchObject({ id: '3', ok: true })
    expect(ospite.last('mic')).toEqual({ t: 'mic', mic: { user: 'cristian', onAir: true } })
    ch.close()
    expect(ospite.last('mic')).toEqual({ t: 'mic', mic: { user: null, onAir: false } })
    expect(t.onAirCalls).toEqual([true, false])
  })
})
