import { describe, expect, it } from 'vitest'
import { creaCodice, indirizzoLocale, leggiCodice } from './codiceCollegamento.ts'

const dati = { host: 'player.radio.it', controlPort: 9443, controlHttps: true, srtPort: 9000, passphrase: 'frase segreta àè', controlToken: 'tokendiprova1234567890' }

describe('codice di collegamento della regia', () => {
  it('va e torna uguale, anche con spazi e a capo in mezzo', () => {
    const c = creaCodice(dati)
    expect(c.startsWith('RADIO-REGIA1.')).toBe(true)
    expect(leggiCodice(c)).toEqual({ ok: true, ...dati })
    expect(leggiCodice(`  ${c.slice(0, 20)}\n${c.slice(20)} `)).toEqual({ ok: true, ...dati })
  })
  it('spiega cosa non va', () => {
    expect(leggiCodice('')).toMatchObject({ ok: false })
    expect(leggiCodice('RADIO1.abc.def')).toMatchObject({ ok: false, errore: expect.stringContaining('chiave di attivazione') })
    expect(leggiCodice('ciao')).toMatchObject({ ok: false, errore: expect.stringContaining('RADIO-REGIA1') })
    expect(leggiCodice(creaCodice(dati).slice(0, 30))).toMatchObject({ ok: false, errore: expect.stringContaining('incompleto') })
  })
  it('riconosce gli indirizzi di casa', () => {
    expect(indirizzoLocale('192.168.1.51')).toBe(true)
    expect(indirizzoLocale('localhost')).toBe(true)
    expect(indirizzoLocale('player.radio.it')).toBe(false)
  })
})
