import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Guests } from './ospiti.ts'
import { VoiceHub } from './voce.ts'
import type { Peer } from './relay.ts'

class FakePeer implements Peer {
  sent: any[] = []
  closed: number | null = null
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close(code = 1000) {
    this.closed = code
  }
  last(t: string) {
    return [...this.sent].reverse().find((m) => m.t === t)
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(now = () => Date.parse('2026-11-15T10:00:00Z')) {
  const onAir: string[] = []
  const slots = [1, 2].map(
    (n) =>
      new VoiceHub({
        factory: async (sdp) => ({ answer: `risposta ${n}:${sdp}`, close: () => {}, sendReturn: () => {} }),
        sendVoice: () => {},
        setOnAir: async (on) => (onAir.push(`ospite${n} ${on}`), true)
      })
  )
  const g = new Guests({ file: join(mkdtempSync(join(tmpdir(), 'osp-')), 'inviti.json'), slots, station: 'Radio Test', listenUrl: 'https://radio/ascolto.mp3', now })
  const lists: any[] = []
  g.onChange = (l) => lists.push(l)
  return { g, onAir, lists }
}

function join_(g: Guests, token: string, name: string) {
  const p = new FakePeer()
  const inv = g.validInvite(token)!
  const h = g.attach(p, inv, 'radio.esempio.it')
  h.message(JSON.stringify({ t: 'join', name }))
  return { p, h }
}

describe('ospiti', () => {
  it('link, sala d\'attesa, ingresso, audio, in onda, chiusura', async () => {
    const { g, onAir } = setup()
    const inv = (await g.command({ type: 'invite', label: 'Mario' }, 'cristian')) as any
    expect(inv.token.length).toBeGreaterThan(20)
    expect(inv.expiresAt).toBe('2026-11-16T10:00:00.000Z')
    const { p, h } = join_(g, inv.token, '  Mario   Rossi ')
    expect(p.sent[0]).toEqual({ t: 'hello', label: 'Mario', station: 'Radio Test', listenUrl: 'https://radio/ascolto.mp3' })
    expect(p.last('state')).toEqual({ t: 'state', state: 'attesa', onAir: false })
    const [guest] = g.list()
    expect(guest).toMatchObject({ name: 'Mario Rossi', state: 'attesa', connected: false })
    // prima di entrare niente audio
    h.message(JSON.stringify({ t: 'rtc-offer', id: '1', sdp: 'x' }))
    expect(p.last('reply')).toMatchObject({ ok: false })
    await expect(g.command({ type: 'air', id: guest.id, on: true }, 'c')).rejects.toThrow(/attesa/)
    await g.command({ type: 'admit', id: guest.id }, 'cristian')
    expect(p.last('state')).toEqual({ t: 'state', state: 'dentro', onAir: false })
    h.message(JSON.stringify({ t: 'rtc-offer', id: '2', sdp: 'offerta' }))
    await flush()
    expect(p.last('reply')).toEqual({ t: 'reply', id: '2', ok: true, data: { sdp: 'risposta 1:offerta' } })
    expect(g.list()[0]).toMatchObject({ state: 'dentro', connected: true })
    await g.command({ type: 'air', id: guest.id, on: true }, 'cristian')
    expect(g.list()[0].onAir).toBe(true)
    expect(p.last('state')).toEqual({ t: 'state', state: 'dentro', onAir: true })
    // la pagina si chiude: fuori onda da solo
    h.close()
    expect(g.list()).toEqual([])
    expect(onAir).toEqual(['ospite1 true', 'ospite1 false'])
  })

  it('posti limitati, rifiuto, link revocati e scaduti', async () => {
    let t = Date.parse('2026-11-15T10:00:00Z')
    const { g } = setup(() => t)
    const inv = (await g.command({ type: 'invite', label: '' }, 'c')) as any
    const a = join_(g, inv.token, 'A')
    const b = join_(g, inv.token, 'B')
    const c = join_(g, inv.token, 'C')
    const [ga, gb, gc] = g.list()
    await g.command({ type: 'admit', id: ga.id }, 'c')
    await g.command({ type: 'admit', id: gb.id }, 'c')
    await expect(g.command({ type: 'admit', id: gc.id }, 'c')).rejects.toThrow(/già 2 ospiti/)
    await g.command({ type: 'reject', id: gc.id }, 'c')
    expect(c.p.last('state').state).toBe('rifiutato')
    expect(c.p.closed).toBe(1000)
    // revoca: chi è entrato con quel link viene chiuso
    await g.command({ type: 'revoke', token: inv.token }, 'c')
    expect(a.p.last('state').state).toBe('chiuso')
    expect(b.p.last('state').state).toBe('chiuso')
    expect(g.list()).toEqual([])
    expect(g.validInvite(inv.token)).toBeNull()
    const inv2 = (await g.command({ type: 'invite', label: 'x' }, 'c')) as any
    t += 25 * 3600_000
    expect(g.validInvite(inv2.token)).toBeNull()
    expect(g.listInvites()).toEqual([])
  })

  it("l'ospite cade mentre il conduttore lo mette in onda: non resta aperto nel mixer", async () => {
    const mixer: string[] = []
    let answer: ((ok: boolean) => void) | null = null
    const slot = new VoiceHub({
      factory: async (sdp) => ({ answer: sdp, close: () => {}, sendReturn: () => {} }),
      sendVoice: () => {},
      setOnAir: (on) => {
        mixer.push(`ospite1 ${on}`)
        return on ? new Promise((r) => (answer = r)) : Promise.resolve(true)
      }
    })
    const g = new Guests({ file: join(mkdtempSync(join(tmpdir(), 'osp-')), 'inviti.json'), slots: [slot], station: 'R', listenUrl: '' })
    const inv = (await g.command({ type: 'invite', label: 'x' }, 'c')) as any
    const { p, h } = join_(g, inv.token, 'Mario')
    const id = g.list()[0].id
    await g.command({ type: 'admit', id }, 'c')
    h.message(JSON.stringify({ t: 'rtc-offer', id: '1', sdp: 'o' }))
    await flush()
    const air = g.command({ type: 'air', id, on: true }, 'c')
    // 4G caduto: la pagina dell'ospite si chiude prima che il mixer risponda
    h.close()
    answer!(true)
    await expect(air).rejects.toThrow(/chiuso/)
    expect(mixer).toEqual(['ospite1 true', 'ospite1 false'])
    expect(p.last('state')).toEqual({ t: 'state', state: 'dentro', onAir: false })
    expect(slot.status()).toMatchObject({ user: null, onAir: false })
  })

  it('chi viene cacciato non rientra con lo stesso link; gli altri con quel link restano', async () => {
    const { g } = setup()
    const inv = (await g.command({ type: 'invite', label: 'x' }, 'c')) as any
    const a = join_(g, inv.token, 'A')
    const b = join_(g, inv.token, 'B')
    const [ga] = g.list()
    await g.command({ type: 'kick', id: ga.id }, 'c')
    expect(a.p.last('state').state).toBe('chiuso')
    expect(g.validInvite(inv.token)).toBeNull()
    expect(g.listInvites()).toEqual([])
    expect(b.p.closed).toBeNull()
    expect(g.list().map((x) => x.name)).toEqual(['B'])
    // la pagina riaperta con quel link non entra più
    const again = new FakePeer()
    g.attach(again, inv, 'h').message(JSON.stringify({ t: 'join', name: 'A' }))
    expect(again.last('state').state).toBe('chiuso')
  })

  it("sala d'attesa piena: si avvisa e la connessione si chiude", async () => {
    const { g } = setup()
    const inv = (await g.command({ type: 'invite', label: '' }, 'c')) as any
    for (let i = 0; i < 10; i++) join_(g, inv.token, `O${i}`)
    const x = join_(g, inv.token, 'Ultimo')
    expect(x.p.last('state').state).toBe('pieno')
    expect(x.p.closed).toBe(1000)
    expect(g.list()).toHaveLength(10)
  })

  it('file dei link rovinato: copiato da parte, si riparte senza link', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osp-'))
    writeFileSync(join(dir, 'inviti.json'), '[{"token": rotto')
    const g = new Guests({ file: join(dir, 'inviti.json'), slots: [], station: 'R', listenUrl: '' })
    expect(g.listInvites()).toEqual([])
    expect(readdirSync(dir).filter((f) => f.startsWith('inviti.json.rovinato-'))).toHaveLength(1)
  })
})
