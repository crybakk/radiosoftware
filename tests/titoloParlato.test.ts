import { describe, expect, it } from 'vitest'
import { SpokenTrigger, type Timers } from '../src/core/titoloParlato'

function fakeTimers() {
  let next: { cb: () => void; ms: number } | null = null
  const timers: Timers = {
    set: (cb, ms) => (next = { cb, ms }),
    clear: () => (next = null)
  }
  return { timers, fire: () => { const n = next; next = null; n?.cb() }, pending: () => next }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('SpokenTrigger (regia)', () => {
  it('dopo 5 secondi senza brani lo dice al ponte, una volta sola', async () => {
    const t = fakeTimers()
    let n = 0
    const tr = new SpokenTrigger(async () => (n++, true), 5000, t.timers)
    tr.update(false)
    expect(t.pending()?.ms).toBe(5000)
    t.fire()
    await flush()
    expect(n).toBe(1)
    tr.update(false)
    expect(t.pending()).toBeNull()
  })
  it('un brano che parte prima dei 5 secondi lo annulla', async () => {
    const t = fakeTimers()
    let n = 0
    const tr = new SpokenTrigger(async () => (n++, true), 5000, t.timers)
    tr.update(false)
    tr.update(true)
    expect(t.pending()).toBeNull()
    // finito il brano si ricomincia
    tr.update(false)
    t.fire()
    await flush()
    expect(n).toBe(1)
  })
  it('se il ponte non risponde si riprova al prossimo aggiornamento', async () => {
    const t = fakeTimers()
    let n = 0
    const tr = new SpokenTrigger(async () => {
      n++
      if (n === 1) throw new Error('ponte giù')
      return true
    }, 5000, t.timers)
    tr.update(false)
    t.fire()
    await flush()
    tr.update(false)
    t.fire()
    await flush()
    expect(n).toBe(2)
  })
})
