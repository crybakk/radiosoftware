// Sceglie il numero della prossima release automatica.
// Uso: node scripts/prossima-versione.mjs <versione di package.json> [versioni già pubblicate...]
// - se la versione di package.json non è ancora pubblicata, usa quella (es. dopo averla portata a 0.2.0);
// - altrimenti aumenta l'ultima cifra partendo dalla più alta già pubblicata con le stesse prime due cifre.
import { pathToFileURL } from 'node:url'

const SEMPLICE = /^(\d+)\.(\d+)\.(\d+)$/

export function prossimaVersione(base, pubblicate) {
  const b = SEMPLICE.exec(base)
  if (!b) throw new Error(`Versione di package.json non valida: ${base}`)
  const giaUsate = new Set(pubblicate)
  if (!giaUsate.has(base)) return base
  let patch = Number(b[3])
  for (const v of pubblicate) {
    const m = SEMPLICE.exec(v)
    if (m && m[1] === b[1] && m[2] === b[2]) patch = Math.max(patch, Number(m[3]))
  }
  return `${b[1]}.${b[2]}.${patch + 1}`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, ...pubblicate] = process.argv.slice(2)
  console.log(prossimaVersione(base, pubblicate))
}
