/**
 * Registro degli errori gravi della regia (cartella dati → logs → regia.log), da mandare a chi ci lavora
 * quando qualcosa si chiude da solo. Tiene solo l'ultimo mega circa: il vecchio diventa regia.old.log.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 1_000_000

export function registro(dir: string): (riga: string) => void {
  const file = join(dir, 'regia.log')
  return (riga) => {
    try {
      mkdirSync(dir, { recursive: true })
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, join(dir, 'regia.old.log'))
      } catch {
        // il file non c'è ancora
      }
      appendFileSync(file, `${new Date().toISOString()} ${riga.trimEnd()}\n`)
    } catch {
      // il registro non deve mai fermare la regia
    }
  }
}
