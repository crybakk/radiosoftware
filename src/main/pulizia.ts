/**
 * Pulizia della libreria (processo principale): togli dalla libreria, sposta negli scarti, rimetti.
 * Nessun file si cancella mai: al massimo si sposta nella sottocartella degli scarti della cartella musica.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import type { RadioDb } from '../core/db'
import { percorsoScarto } from '../core/pulizia'

/** Sposta un file anche tra dischi diversi (rename non basta). */
async function sposta(da: string, a: string): Promise<void> {
  await mkdir(dirname(a), { recursive: true })
  try {
    await rename(da, a)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await copyFile(da, a)
    await unlink(da)
  }
}

/** Un nome libero: "Titolo.mp3", poi "Titolo (2).mp3", ... */
function libero(p: string): string {
  if (!existsSync(p)) return p
  const ext = extname(p)
  const base = p.slice(0, p.length - ext.length)
  for (let n = 2; n < 1000; n++) {
    const c = `${base} (${n})${ext}`
    if (!existsSync(c)) return c
  }
  throw new Error(`troppi file con lo stesso nome: ${p}`)
}

export interface EsitoPulizia {
  fatti: number
  errori: string[]
}

/**
 * Toglie i brani dalla libreria e sposta i file nella sottocartella degli scarti della loro cartella musica.
 * Un file che non si riesce a spostare (aperto da un altro programma, disco in sola lettura) resta dov'è,
 * ma il brano esce comunque dalla libreria.
 */
export async function spostaNegliScarti(db: RadioDb, ids: number[]): Promise<EsitoPulizia> {
  const cartelle = db
    .listFolders()
    .filter((f) => f.kind === 'music')
    .map((f) => f.path)
  const errori: string[] = []
  let fatti = 0
  for (const t of db.getTracks(ids.map(Number))) {
    const dest = percorsoScarto(t.path, cartelle)
    if (!dest || !existsSync(t.path)) {
      fatti += db.togliDallaLibreria([t.id])
      if (!dest) errori.push(`${t.artist} - ${t.title}: il file non è in una cartella della musica, tolto solo dalla libreria`)
      continue
    }
    try {
      const a = libero(dest)
      await sposta(t.path, a)
      db.spostatoNegliScarti(t.id, a, t.path)
      fatti++
    } catch (e) {
      db.togliDallaLibreria([t.id])
      errori.push(`${t.artist} - ${t.title}: file non spostato (${(e as Error).message}), tolto solo dalla libreria`)
    }
  }
  return { fatti, errori }
}

/** Rimette i brani in libreria; i file spostati negli scarti tornano dov'erano. */
export async function rimettiInLibreria(db: RadioDb, ids: number[]): Promise<EsitoPulizia> {
  const errori: string[] = []
  let fatti = 0
  for (const t of db.getTracks(ids.map(Number))) {
    const orig = db.percorsoOriginale(t.id)
    if (orig && existsSync(t.path)) {
      try {
        const a = libero(orig)
        await sposta(t.path, a)
        db.spostatoNegliScarti(t.id, a, '')
      } catch (e) {
        errori.push(`${t.artist} - ${t.title}: file non rimesso a posto (${(e as Error).message})`)
        continue
      }
    }
    fatti += db.rimettiInLibreria([t.id])
  }
  return { fatti, errori }
}
