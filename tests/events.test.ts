import { describe, expect, it } from 'vitest'
import { dueEvents } from '../src/core/events'
import type { ScheduledEvent } from '../src/core/types'

const ev = (p: Partial<ScheduledEvent>): ScheduledEvent => ({
  id: 1, time: '10:00', days: [0, 1, 2, 3, 4, 5, 6], trackId: 1, mode: 'soft', enabled: true, label: '', ...p
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
})
