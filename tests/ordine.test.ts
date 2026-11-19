import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { spostaSezione, unisciOrdine } from '../src/renderer/src/ordine'

// Lo stesso algoritmo del pannello web (classic script, caricato come nel browser ma senza DOM)
const modulo = { exports: {} as { unisciOrdine: typeof unisciOrdine; spostaSezione: typeof spostaSezione } }
runInNewContext(readFileSync(join(__dirname, '..', 'ponte', 'controllo', 'pannello', 'ordine.js'), 'utf8'), { module: modulo })
const pannello = modulo.exports

for (const [nome, f] of [
  ['regia', { unisciOrdine, spostaSezione }],
  ['pannello', pannello]
] as const) {
  describe(`ordine delle sezioni (${nome})`, () => {
    it('senza ordine salvato tiene quello predefinito', () => {
      expect(f.unisciOrdine(['a', 'b', 'c'], null)).toEqual(['a', 'b', 'c'])
      expect(f.unisciOrdine(['a', 'b'], 'rotto' as unknown as string[])).toEqual(['a', 'b'])
    })
    it("rispetta l'ordine salvato", () => {
      expect(f.unisciOrdine(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
    })
    it('una sezione nuova va dopo quella che la precede di solito', () => {
      // "x" arriva con un aggiornamento: nel predefinito sta dopo "a"
      expect(f.unisciOrdine(['a', 'x', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'x', 'b'])
      expect(f.unisciOrdine(['x', 'a', 'b'], ['b', 'a'])).toEqual(['x', 'b', 'a'])
    })
    it('una sezione nascosta non perde il suo posto', () => {
      expect(f.unisciOrdine(['a', 'c'], ['c', 'b', 'a'])).toEqual(['c', 'b', 'a'])
    })
    it('toglie i doppioni', () => {
      expect(f.unisciOrdine(['a', 'b'], ['b', 'b', 'a'])).toEqual(['b', 'a'])
    })
    it('sposta saltando le sezioni che non si vedono', () => {
      const ordine = ['a', 'b', 'c', 'd']
      expect(f.spostaSezione(ordine, ['a', 'b', 'c', 'd'], 'c', -1)).toEqual(['a', 'c', 'b', 'd'])
      // "b" è nascosta: "c" scambia il posto con "a"
      expect(f.spostaSezione(ordine, ['a', 'c', 'd'], 'c', -1)).toEqual(['c', 'b', 'a', 'd'])
      expect(f.spostaSezione(ordine, ['a', 'b', 'c', 'd'], 'd', 1)).toEqual(ordine)
      expect(f.spostaSezione(ordine, ['a', 'b', 'c', 'd'], 'a', -1)).toEqual(ordine)
    })
  })
}
