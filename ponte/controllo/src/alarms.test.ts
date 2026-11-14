import { describe, expect, it } from 'vitest'
import { Alarms } from './alarms.ts'

function setup() {
  let t = 0
  const sent: { text: string; open: boolean }[] = []
  const a = new Alarms({ disconnectedSeconds: 30, heartbeatSeconds: 90, flapCount: 3 }, (text, _k, open) => sent.push({ text, open }), () => t)
  return { a, sent, advance: (s: number) => { t += s * 1000; a.tick() } }
}

describe('allarmi del ponte', () => {
  it('avvisa se la regia resta scollegata oltre la soglia e quando torna', () => {
    const { a, sent, advance } = setup()
    a.onEvent('studio_connesso')
    a.onEvent('studio_scollegato')
    advance(29)
    expect(sent).toHaveLength(0)
    advance(2)
    expect(sent[0]).toMatchObject({ open: true })
    expect(sent[0].text).toContain('AutoDJ')
    a.onEvent('studio_connesso')
    expect(sent[1]).toMatchObject({ open: false })
  })

  it('una breve caduta non genera allarmi', () => {
    const { a, sent, advance } = setup()
    a.onEvent('studio_connesso')
    a.onEvent('studio_scollegato')
    advance(5)
    a.onEvent('studio_connesso')
    advance(60)
    expect(sent).toHaveLength(0)
  })

  it('silenzio solo con regia collegata', () => {
    const { a, sent } = setup()
    a.onEvent('silenzio', '20')
    expect(sent).toHaveLength(0)
    a.onEvent('studio_connesso')
    a.onEvent('silenzio', '20')
    a.onEvent('silenzio', '20')
    expect(sent).toHaveLength(1)
    a.onEvent('audio_ripreso')
    expect(sent[1].open).toBe(false)
  })

  it('regia muta se mancano i segnali di vita', () => {
    const { a, sent, advance } = setup()
    a.onEvent('studio_connesso')
    a.onHeartbeat()
    advance(60)
    expect(sent).toHaveLength(0)
    advance(31)
    expect(sent[0].text).toContain('non risponde')
    a.onHeartbeat()
    expect(sent[1].open).toBe(false)
  })

  it('collegamento instabile con molte riconnessioni', () => {
    const { a, sent, advance } = setup()
    for (let i = 0; i < 3; i++) {
      a.onEvent('studio_connesso')
      a.onEvent('studio_scollegato')
      advance(10)
    }
    a.onEvent('studio_connesso')
    advance(1)
    expect(sent.some((s) => s.text.includes('instabile') && s.open)).toBe(true)
    expect(a.status().alarms.map((x) => x.key)).toContain('collegamento_instabile')
  })
})
