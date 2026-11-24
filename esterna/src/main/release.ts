// File da scaricare per aggiornare Radio Esterna sul Mac (senza firma Apple l'app non si aggiorna da sola).
import { leggiRelease } from '../../../ponte/controllo/src/novita.ts'

/** Indirizzo del .dmg della versione `versione` (Mac), dall'elenco delle release. */
export function dmgDaRelease(release: unknown, versione: string, arch: string = process.arch): string | null {
  for (const r of Array.isArray(release) ? release : []) {
    const info = leggiRelease(r)
    if (!info || info.versione !== versione) continue
    const assets = (r as { assets?: { name?: string; browser_download_url?: string }[] }).assets ?? []
    // un file per i Mac con Apple Silicon (arm64) e uno per i Mac Intel (x64)
    const dmg = assets.filter((x) => typeof x.name === 'string' && x.name.startsWith('RadioEsterna-') && x.name.endsWith('.dmg'))
    const a = dmg.find((x) => x.name!.endsWith(`-${arch}.dmg`)) ?? dmg[0]
    if (a?.browser_download_url) return a.browser_download_url
  }
  return null
}

