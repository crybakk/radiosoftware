import { describe, expect, it } from 'vitest'
import { Relay, type Peer } from './relay.ts'

class FakePeer implements Peer {
  sent: any[] = []
  closed: number | null = null
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close(code = 1000) {
    this.closed = code
  }
  last(t?: string) {
    return [...this.sent].reverse().find((m) => !t || m.t === t)
  }
}

const state = { mode: 'auto', onAir: null, queue: [], carts: [], uplink: 'collegato', lastError: null, at: '' } as const

function connectStudio(r: Relay, token = 'tok') {
  const p = new FakePeer()
  const h = r.attachStudio(p)
  h.message(JSON.stringify({ t: 'auth', token }))
  return { p, h }
}

describe('smistamento tra pannello e regia', () => {
  it('la regia deve autenticarsi', () => {
    const r = new Relay('tok')
    const { p } = connectStudio(r, 'sbagliato')
    expect(p.closed).toBe(4003)
    expect(r.studioConnected()).toBe(false)
    const ok = connectStudio(r)
    expect(ok.p.last()).toEqual({ t: 'auth-ok' })
    expect(r.studioConnected()).toBe(true)
  })

  it('stato della regia ai pannelli, comandi alla regia, risposta al pannello giusto', () => {
    const r = new Relay('tok')
    const s = connectStudio(r)
    const panel = new FakePeer()
    const ph = r.attachPanel(panel, { name: 'anna', role: 'conduttore' })
    expect(panel.sent[0]).toMatchObject({ t: 'hello', studio: true, state: null })
    s.h.message(JSON.stringify({ t: 'state', state }))
    expect(panel.last('state').state.mode).toBe('auto')
    ph.message(JSON.stringify({ t: 'cmd', id: 'p1', cmd: { type: 'next' } }))
    const cmd = s.p.last('cmd')
    expect(cmd).toMatchObject({ cmd: { type: 'next' }, by: 'anna' })
    s.h.message(JSON.stringify({ t: 'reply', id: cmd.id, ok: true }))
    expect(panel.last('reply')).toEqual({ t: 'reply', id: 'p1', ok: true })
  })

  it("l'ospite può cercare ma non comandare", () => {
    const r = new Relay('tok')
    const s = connectStudio(r)
    const panel = new FakePeer()
    const ph = r.attachPanel(panel, { name: 'ospite', role: 'ospite' })
    ph.message(JSON.stringify({ t: 'cmd', id: 'p1', cmd: { type: 'stop' } }))
    expect(panel.last('reply')).toMatchObject({ ok: false, error: expect.stringContaining('ruolo') })
    expect(s.p.last('cmd')).toBeUndefined()
    ph.message(JSON.stringify({ t: 'cmd', id: 'p2', cmd: { type: 'search', q: 'battisti' } }))
    expect(s.p.last('cmd').cmd.type).toBe('search')
  })

  it('regia scollegata: i pannelli lo sanno e i comandi falliscono', () => {
    const r = new Relay('tok')
    const s = connectStudio(r)
    const panel = new FakePeer()
    const ph = r.attachPanel(panel, { name: 'anna', role: 'conduttore' })
    ph.message(JSON.stringify({ t: 'cmd', id: 'p1', cmd: { type: 'play' } }))
    s.h.close()
    expect(panel.sent.some((m) => m.t === 'studio' && m.connected === false)).toBe(true)
    expect(panel.last('reply')).toMatchObject({ id: 'p1', ok: false, error: 'regia scollegata' })
    ph.message(JSON.stringify({ t: 'cmd', id: 'p2', cmd: { type: 'play' } }))
    expect(panel.last('reply')).toMatchObject({ id: 'p2', ok: false })
  })

  it('una nuova connessione della regia sostituisce la vecchia', () => {
    const r = new Relay('tok')
    const a = connectStudio(r)
    connectStudio(r)
    expect(a.p.closed).toBe(4000)
    a.h.close() // la chiusura della vecchia non deve scollegare la nuova
    expect(r.studioConnected()).toBe(true)
  })
})
