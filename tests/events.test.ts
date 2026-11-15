import { describe, expect, it } from 'vitest'
import { dueEvents, nextOccurrences, occurrencesOnDay } from '../src/core/events'
import type { ScheduledEvent } from '../src/core/types'

const ev = (p: Partial<ScheduledEvent>): ScheduledEvent => ({
  id: 1, label: '', time: '10:00', days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null, validFrom: null,
  validTo: null, mode: 'soft', toleranceSeconds: 0, actions: [{ type: 'clear' }], enabled: true, ...p
})

describe('eventi a orario', () => {
  it('scatta una volta quando si attraversa l\'orario', () => {
    const e = ev({})
    expect(dueEvents([e], new Date(2026, 10, 16, 9, 59, 59), new Date(2026, 10, 16, 10, 0, 0))).toHaveLength(1)
    expect(dueEvents([e], new Date(2026, 10, 16, 10, 0, 0), new Date(2026, 10, 16, 10, 0, 1))).toHaveLength(0)
  })
  it('rispetta i giorni', () => {
    // 16/11/2026 è lunedì (1)
    const e = ev({ days: [0, 6] })
    expect(dueEvents([e], new Date(2026, 10, 16, 9, 59), new Date(2026, 10, 16, 10, 1))).toHaveLength(0)
  })
  it('gestisce la mezzanotte', () => {
    const e = ev({ time: '00:00' })
    expect(dueEvents([e], new Date(2026, 10, 16, 23, 59, 50), new Date(2026, 10, 17, 0, 0, 5))).toHaveLength(1)
  })
  it('ignora eventi disabilitati e non recupera ore di sospensione', () => {
    expect(dueEvents([ev({ enabled: false })], new Date(2026, 10, 16, 9), new Date(2026, 10, 16, 11))).toHaveLength(0)
    expect(dueEvents([ev({})], new Date(2026, 10, 16, 9), new Date(2026, 10, 16, 11))).toHaveLength(0)
  })
  it('ogni ora al minuto indicato', () => {
    const e = ev({ time: '*:00' })
    expect(dueEvents([e], new Date(2026, 10, 16, 9, 59, 59), new Date(2026, 10, 16, 10, 0, 0))).toHaveLength(1)
    expect(dueEvents([e], new Date(2026, 10, 16, 10, 0, 0), new Date(2026, 10, 16, 10, 0, 1))).toHaveLength(0)
    expect(dueEvents([e], new Date(2026, 10, 16, 23, 59, 59), new Date(2026, 10, 17, 0, 0, 0))).toHaveLength(1)
  })
  it('si ripete ogni N minuti fino all\'orario di fine', () => {
    const e = ev({ time: '10:00', repeatMinutes: 15, untilTime: '11:00' })
    const day = new Date(2026, 10, 16)
    expect(occurrencesOnDay(e, day).map((d) => d.getHours() * 60 + d.getMinutes())).toEqual([600, 615, 630, 645, 660])
    expect(dueEvents([e], new Date(2026, 10, 16, 10, 29, 59), new Date(2026, 10, 16, 10, 30, 0))).toHaveLength(1)
  })
  it('rispetta le date di validità', () => {
    const e = ev({ validFrom: '2026-12-01', validTo: '2026-12-24' })
    expect(occurrencesOnDay(e, new Date(2026, 10, 30))).toHaveLength(0)
    expect(occurrencesOnDay(e, new Date(2026, 11, 1))).toHaveLength(1)
    expect(occurrencesOnDay(e, new Date(2026, 11, 24))).toHaveLength(1)
    expect(occurrencesOnDay(e, new Date(2026, 11, 25))).toHaveLength(0)
  })
  it('elenca le prossime occorrenze', () => {
    const list = nextOccurrences([ev({ time: '10:00' }), ev({ id: 2, time: '*:30' })], new Date(2026, 10, 16, 9, 0), 3)
    expect(list.map((o) => `${o.at.getHours()}:${o.at.getMinutes()}`)).toEqual(['9:30', '10:0', '10:30'])
  })
})
