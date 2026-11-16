import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * La finestra della regia può usare le funzioni del programma (eventi, comandi esterni,
 * impostazioni, ripristino) solo dalla sua pagina: se per sbaglio vi si trascina un file
 * o un link, quella pagina estranea non deve poterle chiamare.
 */
export function paginaRegia(url: string, rendererFile: string, devUrl?: string): boolean {
  if (!url) return false
  if (devUrl) {
    try {
      return new URL(url).origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  try {
    const u = new URL(url)
    const atteso = pathToFileURL(rendererFile)
    const norm = (x: string): string => {
      const d = decodeURIComponent(x)
      return process.platform === 'win32' ? d.toLowerCase() : d
    }
    return u.protocol === 'file:' && norm(u.pathname) === norm(atteso.pathname)
  } catch {
    return false
  }
}

/** Vero se `p` è dentro la cartella `dir` (dopo aver risolto "..", non solo per prefisso). */
export function dentroCartella(p: string, dir: string): boolean {
  if (!p || !dir) return false
  const rel = relative(resolve(dir), resolve(p))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
