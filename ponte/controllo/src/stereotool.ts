/**
 * Predisposizione per Stereo Tool (Thimeo), scelte di cristian (17/11/2026): quinta scelta "stereotool" del
 * processore audio. La libreria per Linux la scarica riavvia.sh nella cartella ./stereotool del server; il
 * preset (.sts) si regola sul PC con Stereo Tool e si carica dal pannello. La chiave di licenza è facoltativa.
 * Se Stereo Tool non parte, Liquidsoap usa il processore "medio" e arriva un allarme.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LIBRERIA = 'libStereoTool.so'
export const PRESET = 'preset.sts'
const INFO = 'preset.json'
export const MAX_PRESET_BYTES = 2 * 1024 * 1024

export interface StatoStereoTool {
  /** la cartella è collegata al controllo (server installato con questa versione) */
  disponibile: boolean
  libreria: boolean
  preset: { nome: string; byte: number; quando: string } | null
}

export class StereoTool {
  private readonly dir: string
  private readonly now: () => number

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir
    this.now = now
  }

  stato(): StatoStereoTool {
    const disponibile = existsSync(this.dir)
    let preset: StatoStereoTool['preset'] = null
    const f = join(this.dir, PRESET)
    if (existsSync(f)) {
      let info: { nome?: string; quando?: string } = {}
      try {
        info = JSON.parse(readFileSync(join(this.dir, INFO), 'utf8'))
      } catch {
        // preset messo a mano sul server
      }
      const st = statSync(f)
      preset = { nome: info.nome || PRESET, byte: st.size, quando: info.quando || st.mtime.toISOString() }
    }
    return { disponibile, libreria: existsSync(join(this.dir, LIBRERIA)), preset }
  }

  /** Salva il preset caricato dal pannello; restituisce l'ora del caricamento. */
  async salvaPreset(nome: string, dati: Buffer): Promise<string> {
    if (!existsSync(this.dir)) throw new Error('cartella di Stereo Tool non collegata: aggiorna il server')
    controllaPreset(nome, dati)
    const quando = new Date(this.now()).toISOString()
    // prima un file temporaneo, poi lo scambio: Liquidsoap non legge mai un preset a metà
    const tmp = join(this.dir, `${PRESET}.nuovo`)
    await writeFile(tmp, dati, { mode: 0o644 })
    await rename(tmp, join(this.dir, PRESET))
    await writeFile(join(this.dir, INFO), JSON.stringify({ nome: nomePulito(nome), quando }), { mode: 0o644 })
    return quando
  }
}

const nomePulito = (nome: string): string => nome.replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 100) || PRESET

export function controllaPreset(nome: string, dati: Buffer): void {
  if (!/\.sts$/i.test(nome)) throw new Error('il preset di Stereo Tool è un file .sts')
  if (!dati.length) throw new Error('il file è vuoto')
  if (dati.length > MAX_PRESET_BYTES) throw new Error('file troppo grande per un preset (massimo 2 MB)')
  // un preset è testo: un file binario (programma, immagine, zip) è stato scelto per sbaglio
  if (dati.subarray(0, 4096).includes(0)) throw new Error('questo file non sembra un preset di Stereo Tool')
}
