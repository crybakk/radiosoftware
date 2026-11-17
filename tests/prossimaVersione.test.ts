import { describe, expect, it } from 'vitest'
// @ts-expect-error script .mjs senza tipi, usato dalla pubblicazione automatica delle release
import { prossimaVersione } from '../scripts/prossima-versione.mjs'

describe('prossima versione della release automatica', () => {
  it('usa la versione di package.json se non è ancora pubblicata', () => {
    expect(prossimaVersione('0.1.0', [])).toBe('0.1.0')
    expect(prossimaVersione('0.2.0', ['0.1.0', '0.1.7'])).toBe('0.2.0')
  })
  it("altrimenti aumenta l'ultima cifra dalla più alta pubblicata", () => {
    expect(prossimaVersione('0.1.0', ['0.1.0'])).toBe('0.1.1')
    expect(prossimaVersione('0.1.0', ['0.1.0', '0.1.3', '0.1.10', '0.1.2'])).toBe('0.1.11')
    expect(prossimaVersione('0.2.0', ['0.2.0', '0.1.9', '1.2.5'])).toBe('0.2.1')
  })
  it('ignora i tag non numerici', () => {
    expect(prossimaVersione('0.1.0', ['0.1.0', '0.1.5-prova', 'abc'])).toBe('0.1.1')
  })
  it('rifiuta una versione strana in package.json', () => {
    expect(() => prossimaVersione('0.1', [])).toThrow()
  })
})
