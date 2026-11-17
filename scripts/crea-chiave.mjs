// Crea una chiave di attivazione per regia e server.
// Uso: node scripts/crea-chiave.mjs <file chiave segreta .pem> "Nome della radio"
// La chiave segreta resta solo sul tuo PC: non metterla mai nel repository.
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function creaChiave(chiaveSegreta, radio, creata = new Date().toISOString().slice(0, 10)) {
  const dati = Buffer.from(JSON.stringify({ radio, creata })).toString('base64url')
  const testa = `RADIO1.${dati}`
  return `${testa}.${sign(null, Buffer.from(testa), chiaveSegreta).toString('base64url')}`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, radio] = process.argv.slice(2)
  if (!file || !radio) {
    console.error('Uso: node scripts/crea-chiave.mjs <chiave-segreta.pem> "Nome della radio"')
    process.exit(1)
  }
  console.log(creaChiave(createPrivateKey(readFileSync(file)), radio.trim()))
}
