import { describe, expect, it } from 'vitest'
import type { PublicUser } from './users.ts'
import { MAX_PENDING_PER_PANEL, Relay, type Peer } from './relay.ts'

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

  it('una ricerca alla volta e pochi comandi in attesa per pannello', () => {
    const r = new Relay('tok')
    const s = connectStudio(r)
    const panel = new FakePeer()
    const ph = r.attachPanel(panel, { name: 'anna', role: 'conduttore' })
    const other = new FakePeer()
    const oh = r.attachPanel(other, { name: 'bea', role: 'ospite' })
    ph.message(JSON.stringify({ t: 'cmd', id: 's1', cmd: { type: 'search', q: 'a' } }))
    const first = s.p.last('cmd')
    ph.message(JSON.stringify({ t: 'cmd', id: 's2', cmd: { type: 'search', q: 'b' } }))
    expect(panel.last('reply')).toMatchObject({ id: 's2', ok: false, error: expect.stringContaining('ricerca') })
    // un altro pannello può cercare
    oh.message(JSON.stringify({ t: 'cmd', id: 'o1', cmd: { type: 'search', q: 'c' } }))
    expect(s.p.last('cmd').cmd.q).toBe('c')
    // finita la prima, si può cercare di nuovo
    s.h.message(JSON.stringify({ t: 'reply', id: first.id, ok: true, data: [] }))
    ph.message(JSON.stringify({ t: 'cmd', id: 's3', cmd: { type: 'search', q: 'd' } }))
    expect(s.p.last('cmd').cmd.q).toBe('d')
    const before = s.p.sent.length
    for (let i = 0; i < MAX_PENDING_PER_PANEL + 5; i++) ph.message(JSON.stringify({ t: 'cmd', id: `n${i}`, cmd: { type: 'next' } }))
    expect(s.p.sent.length - before).toBe(MAX_PENDING_PER_PANEL - 1)
    expect(panel.last('reply')).toMatchObject({ ok: false, error: expect.stringContaining('troppi') })
    ph.close()
    oh.close()
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

  it('messaggi JSON validi ma non oggetti vengono ignorati (regia e pannello, anche senza autenticazione)', () => {
    const r = new Relay('tok')
    const anon = new FakePeer()
    const ah = r.attachStudio(anon)
    for (const raw of ['null', '3', '"x"', '[]', 'true']) expect(() => ah.message(raw)).not.toThrow()
    const s = connectStudio(r)
    for (const raw of ['null', '3', '[]', '{"t":"reply","id":null}']) expect(() => s.h.message(raw)).not.toThrow()
    const panel = new FakePeer()
    const ph = r.attachPanel(panel, { name: 'anna', role: 'conduttore' })
    for (const raw of ['null', '3', '[]', '{"t":"cmd","id":"p1","cmd":null}', '{"t":"cmd","id":"p1","cmd":5}']) {
      expect(() => ph.message(raw)).not.toThrow()
    }
    expect(s.p.last('cmd')).toBeUndefined()
    expect(r.studioConnected()).toBe(true)
  })

  it('il token della regia deve essere una stringa uguale', () => {
    const r = new Relay('tok')
    const p = new FakePeer()
    r.attachStudio(p).message(JSON.stringify({ t: 'auth', token: ['tok'] }))
    expect(p.closed).toBe(4003)
  })

  it('segnale di vita alla regia collegata (solo dopo l\'autenticazione)', () => {
    const r = new Relay('tok')
    const anon = new FakePeer()
    r.attachStudio(anon)
    r.pingStudio()
    expect(anon.sent).toEqual([])
    const s = connectStudio(r)
    r.pingStudio()
    expect(s.p.last()).toEqual({ t: 'ping' })
  })

  it('a ogni comando si usa il ruolo attuale della sessione', () => {
    const r = new Relay('tok')
    const s = connectStudio(r)
    const panel = new FakePeer()
    let now: PublicUser | null = { name: 'anna', role: 'conduttore' }
    const ph = r.attachPanel(panel, { name: 'anna', role: 'conduttore' }, undefined, () => now)
    ph.message(JSON.stringify({ t: 'cmd', id: 'p1', cmd: { type: 'stop' } }))
    expect(s.p.last('cmd')).toMatchObject({ cmd: { type: 'stop' } })
    s.p.sent = []
    now = { name: 'anna', role: 'ospite' }
    ph.message(JSON.stringify({ t: 'cmd', id: 'p2', cmd: { type: 'stop' } }))
    expect(panel.last('reply')).toMatchObject({ id: 'p2', ok: false, error: expect.stringContaining('ruolo') })
    expect(s.p.last('cmd')).toBeUndefined()
    now = null // sessione chiusa o scaduta, utente eliminato
    ph.message(JSON.stringify({ t: 'cmd', id: 'p3', cmd: { type: 'search', q: 'x' } }))
    expect(panel.closed).toBe(4003)
    expect(s.p.last('cmd')).toBeUndefined()
  })

  it('kick chiude solo le connessioni di quell\'utente, con il codice richiesto', () => {
    const r = new Relay('tok')
    const a = new FakePeer()
    const b = new FakePeer()
    r.attachPanel(a, { name: 'Anna', role: 'conduttore' })
    r.attachPanel(b, { name: 'luca', role: 'conduttore' })
    r.kick('anna', 4002, 'ruolo cambiato')
    expect(a.closed).toBe(4002)
    expect(b.closed).toBeNull()
    r.kick('luca')
    expect(b.closed).toBe(4003)
  })
})


describe('eventi e rotazioni da remoto', () => {
  it('elenco per tutti, esegui ora per chi comanda, modifiche solo agli amministratori', () => {
    const r = new Relay('tok')
    const s = connectStudio(r)
    const try_ = (role: string, cmd: object) => {
      const panel = new FakePeer()
      const ph = r.attachPanel(panel, { name: role, role } as PublicUser)
      const before = s.p.sent.length
      ph.message(JSON.stringify({ t: 'cmd', id: 'x', cmd }))
      return s.p.sent.length > before ? 'inviato' : panel.last('reply').error
    }
    expect(try_('ospite', { type: 'events' })).toBe('inviato')
    expect(try_('ospite', { type: 'eventRun', id: 1 })).toContain('ruolo')
    expect(try_('conduttore', { type: 'eventRun', id: 1 })).toBe('inviato')
    expect(try_('conduttore', { type: 'rotationSet', profile: null })).toBe('inviato')
    expect(try_('conduttore', { type: 'eventSave', event: {} })).toContain('amministratori')
    expect(try_('conduttore', { type: 'eventEnable', id: 1, on: false })).toContain('amministratori')
    expect(try_('amministratore', { type: 'eventDelete', id: 1 })).toBe('inviato')
  })

  it('comandi dal server (bot Telegram) con risposta come promessa', async () => {
    const r = new Relay('tok')
    await expect(r.command({ type: 'events' }, 'Telegram')).rejects.toThrow('scollegata')
    const s = connectStudio(r)
    const p = r.command({ type: 'events' }, 'Telegram: @cri')
    const cmd = s.p.last('cmd')
    expect(cmd).toMatchObject({ cmd: { type: 'events' }, by: 'Telegram: @cri' })
    s.h.message(JSON.stringify({ t: 'reply', id: cmd.id, ok: true, data: { events: [] } }))
    await expect(p).resolves.toEqual({ events: [] })
    const q = r.command({ type: 'eventRun', id: 9 }, 'Telegram')
    s.h.message(JSON.stringify({ t: 'reply', id: s.p.last('cmd').id, ok: false, error: 'evento non trovato' }))
    await expect(q).rejects.toThrow('evento non trovato')
  })
})
