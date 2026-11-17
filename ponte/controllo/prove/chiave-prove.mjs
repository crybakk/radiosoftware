// Solo per le prove automatiche: si carica prima del server (node --import) per farlo partire
// con una chiave di attivazione di prova, firmata con una coppia di chiavi creata al momento.
import { generateKeyPairSync, sign } from 'node:crypto'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
globalThis.__radioChiavePubblicaProve = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
if (process.env.CHIAVE_ATTIVAZIONE === undefined) {
  const testa = `RADIO1.${Buffer.from(JSON.stringify({ radio: 'Radio di prova', creata: '2026-01-01' })).toString('base64url')}`
  process.env.CHIAVE_ATTIVAZIONE = `${testa}.${sign(null, Buffer.from(testa), privateKey).toString('base64url')}`
}
