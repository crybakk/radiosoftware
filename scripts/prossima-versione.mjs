// Sceglie il numero della prossima release automatica.
// Uso: node scripts/prossima-versione.mjs <versione di package.json> [versioni già pubblicate...]
// - se la versione di package.json è più alta di tutte quelle pubblicate, usa quella (es. dopo averla portata a 0.2.0);
// - altrimenti aumenta l'ultima cifra partendo dalla più alta già pubblicata con le stesse prime due cifre
//   (anche se una release vecchia è stata cancellata, il suo numero non si riusa).
import { pathToFileURL } from 'node:url'

const SEMPLICE = /^(\d+)\.(\d+)\.(\d+)$/

export function prossimaVersione(base, pubblicate) {
  const b = SEMPLICE.exec(base)
  if (!b) throw new Error(`Versione di package.json non valida: ${base}`)
  const num = (m) => [Number(m[1]), Number(m[2]), Number(m[3])]
  const maggiore = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  const valide = pubblicate.map((v) => SEMPLICE.exec(v)).filter(Boolean)
  if (valide.every((m) => maggiore(num(b), num(m)) > 0)) return base
  let patch = Number(b[3])
  for (const m of valide) if (m[1] === b[1] && m[2] === b[2]) patch = Math.max(patch, Number(m[3]))
  return `${b[1]}.${b[2]}.${patch + 1}`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, ...pubblicate] = process.argv.slice(2)
  console.log(prossimaVersione(base, pubblicate))
}
