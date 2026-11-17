import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verificaChiave } from '../ponte/controllo/src/licenza'
import { Attivazione } from '../ponte/controllo/src/attivazione'
// @ts-expect-error script .mjs senza tipi
import { creaChiave } from '../scripts/crea-chiave.mjs'

const g = globalThis as { __radioChiavePubblicaProve?: string }
let segreta: KeyObject

beforeAll(() => {
  const coppia = generateKeyPairSync('ed25519')
  segreta = coppia.privateKey
  g.__radioChiavePubblicaProve = coppia.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
})
afterAll(() => {
  delete g.__radioChiavePubblicaProve
})

describe('chiave di attivazione', () => {
  it('accetta una chiave firmata e ne legge i dati, anche con spazi e a capo', () => {
    const k = creaChiave(segreta, 'Radio Attiva', '2026-11-17') as string
    expect(verificaChiave(k)).toEqual({ ok: true, radio: 'Radio Attiva', creata: '2026-11-17' })
    expect(verificaChiave(`  ${k.slice(0, 30)}\n${k.slice(30)} `).ok).toBe(true)
  })
  it('rifiuta chiavi vuote, malformate, modificate o firmate da altri', () => {
    const k = creaChiave(segreta, 'Radio Attiva') as string
    expect(verificaChiave('').ok).toBe(false)
    expect(verificaChiave('ciao').ok).toBe(false)
    const [p, , firma] = k.split('.')
    const altriDati = Buffer.from(JSON.stringify({ radio: 'Altra radio', creata: '2026-11-17' })).toString('base64url')
    expect(verificaChiave(`${p}.${altriDati}.${firma}`).ok).toBe(false)
    const estranea = creaChiave(generateKeyPairSync('ed25519').privateKey, 'Radio Attiva') as string
    expect(verificaChiave(estranea).ok).toBe(false)
  })
  it('la chiave vera del programma non accetta chiavi di prova', () => {
    const prova = g.__radioChiavePubblicaProve
    delete g.__radioChiavePubblicaProve
    try {
      expect(verificaChiave(creaChiave(segreta, 'Radio Attiva')).ok).toBe(false)
    } finally {
      g.__radioChiavePubblicaProve = prova
    }
  })
  it('il server salva nel .env la chiave valida incollata dal pannello', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'attivazione-')), '.env')
    writeFileSync(file, '# impostazioni\nNOME_RADIO=Radio\n')
    const a = new Attivazione(undefined, file)
    expect(a.attivo()).toBe(false)
    expect(a.attiva('sbagliata').ok).toBe(false)
    expect(readFileSync(file, 'utf8')).not.toContain('CHIAVE_ATTIVAZIONE')
    const k = creaChiave(segreta, 'Radio Attiva') as string
    expect(a.attiva(`${k}\n`).ok).toBe(true)
    expect(a.attivo()).toBe(true)
    expect(a.radio()).toBe('Radio Attiva')
    expect(readFileSync(file, 'utf8')).toContain(`CHIAVE_ATTIVAZIONE=${k}`)
    expect(readFileSync(file, 'utf8')).toContain('NOME_RADIO=Radio')
    expect(new Attivazione(k, file).attivo()).toBe(true)
  })
})
