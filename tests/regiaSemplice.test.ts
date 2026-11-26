import { describe, expect, it } from 'vitest'
import { scegliUscite } from '../src/renderer/src/sceltaSchede'
import { statoMuta } from '../src/renderer/src/AvvisoMuta'

describe('scelta automatica delle schede audio', () => {
  it('in onda il RodeCaster (non la chat), preascolto le casse del PC', () => {
    const r = scegliUscite([
      { deviceId: '', label: 'Predefinito - Altoparlanti (Realtek)' },
      { deviceId: 'communications', label: 'Comunicazioni - RØDECaster Duo Chat' },
      { deviceId: 'a', label: 'RØDECaster Duo Chat' },
      { deviceId: 'b', label: 'RØDECaster Duo Main' },
      { deviceId: 'c', label: 'Altoparlanti (Realtek(R) Audio)' }
    ])
    expect(r).toEqual({ onda: 'b', preascolto: 'c', rodecaster: true })
  })
  it('senza RodeCaster resta tutto sulla predefinita', () => {
    expect(scegliUscite([{ deviceId: '', label: 'Predefinito' }])).toEqual({ onda: '', preascolto: '', rodecaster: false })
  })
})

describe('avviso "la musica sta per finire"', () => {
  const base = { mode: 'manual' as const, remaining: 20.2, queue: 0, fermaDaSecondi: 0 }
  it('in manuale con la coda vuota conta i secondi', () => {
    expect(statoMuta(base)).toEqual({ tipo: 'finisce', secondi: 21 })
  })
  it('niente avviso in automatico, con brani in coda o lontano dalla fine', () => {
    expect(statoMuta({ ...base, mode: 'auto' })).toBeNull()
    expect(statoMuta({ ...base, queue: 1 })).toBeNull()
    expect(statoMuta({ ...base, remaining: 90 })).toBeNull()
  })
  it('regia ferma: avvisa solo dopo qualche secondo', () => {
    expect(statoMuta({ ...base, remaining: null, fermaDaSecondi: 1 })).toBeNull()
    expect(statoMuta({ ...base, remaining: null, fermaDaSecondi: 6 })).toEqual({ tipo: 'ferma' })
  })
})
