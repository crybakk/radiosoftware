// Le date qui sotto sono in ora locale italiana: il fuso va impostato prima di creare qualsiasi data.
process.env.TZ = 'Europe/Rome'
import { describe, expect, it } from 'vitest'
import { dueEvents, occurrencesOnDay } from '../src/core/events'
import type { ScheduledEvent } from '../src/core/types'

const ev = (p: Partial<ScheduledEvent>): ScheduledEvent => ({
  id: 1, label: '', time: '10:00', days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null, validFrom: null,
  validTo: null, mode: 'soft', toleranceSeconds: 0, actions: [{ type: 'clear' }], enabled: true, ...p
})

describe('eventi e ora legale', () => {
  it('il fuso del test è quello italiano', () => {
    // 29/3/2026 01:00 UTC = 03:00 CEST
    expect(new Date(Date.UTC(2026, 2, 29, 1, 0)).getHours()).toBe(3)
  })

  it('evento orario *:30 non scatta due volte il 29/3/2026 (passaggio all\'ora legale)', () => {
    const e = ev({ time: '*:30' })
    const times = occurrencesOnDay(e, new Date(2026, 2, 29, 12)).map((d) => d.getTime())
    expect(new Set(times).size).toBe(times.length)
    expect(times).toHaveLength(23)
    // 02:30 non esiste: alle 03:30 l'evento scatta una volta sola
    const due = dueEvents([e], new Date(Date.UTC(2026, 2, 29, 1, 29)), new Date(Date.UTC(2026, 2, 29, 1, 30)))
    expect(due).toHaveLength(1)
  })

  it('"ogni N minuti" attraverso il cambio d\'ora non duplica le occorrenze', () => {
    const e = ev({ time: '01:00', repeatMinutes: 30, untilTime: '05:00' })
    const times = occurrencesOnDay(e, new Date(2026, 2, 29, 12)).map((d) => d.getTime())
    expect(new Set(times).size).toBe(times.length)
  })
})
