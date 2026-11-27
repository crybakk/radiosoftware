/**
 * Player pubblico installabile come app (telefono e computer), richiesta di cristian del 27/11/2026.
 *
 * - /manifest.webmanifest: nome della radio (NOME_RADIO), colori del player, icone;
 * - /icona-192.png, /icona-512.png, /icona-maskable.png, /apple-touch-icon.png: fatte dal logo della radio
 *   (quello delle dirette video, caricato dal pannello) con ffmpeg, centrato su un quadrato scuro;
 *   senza logo, o se ffmpeg non ce la fa, le icone di base (onde radio rosse) che stanno in pannello/.
 * Le icone fatte dal logo si rifanno da sole quando il logo cambia.
 */
import { execFile } from 'node:child_process'
import { stat, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const SFONDO = '#0f1216'

/** Icone servite: nome nell'indirizzo → lato in pixel e quanta parte del quadrato occupa il logo. */
export const ICONE: Record<string, { lato: number; parte: number; base: string }> = {
  'icona-192.png': { lato: 192, parte: 0.92, base: 'icona-radio-192.png' },
  'icona-512.png': { lato: 512, parte: 0.92, base: 'icona-radio-512.png' },
  // "maskable": Android ritaglia l'icona a cerchio o goccia, il logo deve stare nel 70% centrale
  'icona-maskable.png': { lato: 512, parte: 0.66, base: 'icona-radio-maskable.png' },
  // iPhone e iPad la cercano da soli a questo indirizzo; angoli arrotondati li fa iOS
  'apple-touch-icon.png': { lato: 180, parte: 0.86, base: 'icona-radio-192.png' }
}

export function nomeIcona(path: string): string | null {
  const n = path.replace(/^\//, '').replace(/^apple-touch-icon-precomposed\.png$/, 'apple-touch-icon.png')
  return Object.hasOwn(ICONE, n) ? n : null
}

/** Nome corto sotto l'icona del telefono: al massimo 12 caratteri, se no si vede tagliato. */
export function nomeCorto(nome: string): string {
  const n = nome.trim() || 'Radio'
  if (n.length <= 12) return n
  const parole = n.split(/\s+/)
  let s = ''
  for (const p of parole) {
    if ((s ? `${s} ${p}` : p).length > 12) break
    s = s ? `${s} ${p}` : p
  }
  return s || n.slice(0, 12)
}

export function manifest(nome: string, descrizione: string, versione: string): Record<string, unknown> {
  const n = nome.trim() || 'Radio'
  const v = versione ? `?v=${versione}` : ''
  return {
    id: '/',
    name: n,
    short_name: nomeCorto(n),
    description: descrizione || `Ascolta ${n} in diretta`,
    lang: 'it',
    start_url: '/?app=1',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: SFONDO,
    theme_color: SFONDO,
    categories: ['music', 'entertainment'],
    icons: [
      { src: `/icona-192.png${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/icona-512.png${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/icona-maskable.png${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    shortcuts: [{ name: 'Puntate', url: '/podcast.html', icons: [{ src: `/icona-192.png${v}`, sizes: '192x192', type: 'image/png' }] }]
  }
}

/** Filtro di ffmpeg: logo rimpicciolito senza deformarlo, al centro di un quadrato del colore del player. */
export function filtroIcona(lato: number, parte: number): string {
  const l = Math.round(lato * parte)
  return `scale=${l}:${l}:force_original_aspect_ratio=decrease,pad=${lato}:${lato}:(ow-iw)/2:(oh-ih)/2:color=0x0f1216,format=rgb24`
}

export interface IconeDeps {
  /** file del logo (png o jpg) o null se non c'è */
  logo: () => string | null
  /** cartella dove tenere le icone fatte dal logo */
  cartella: string
  /** cartella del pannello, con le icone di base */
  pannello: string
  ffmpeg?: string
  log?: (s: string) => void
}

export class IconeApp {
  private chiaveFatta = ''
  private inCorso: Promise<boolean> | null = null
  private fallitaPer = ''

  private d: IconeDeps

  constructor(d: IconeDeps) {
    this.d = d
  }

  /** Cambia quando cambia il logo: va negli indirizzi delle icone, così telefoni e browser le riscaricano. */
  async versione(): Promise<string> {
    const f = this.d.logo()
    if (!f) return 'base'
    const s = await stat(f).catch(() => null)
    return s ? `${Math.round(s.mtimeMs).toString(36)}${s.size.toString(36)}` : 'base'
  }

  /** Contenuto PNG dell'icona: dal logo se c'è (e ffmpeg ce la fa), se no quella di base. */
  async icona(nome: string): Promise<Buffer | null> {
    const def = ICONE[nome]
    if (!def) return null
    const v = await this.versione()
    if (v !== 'base' && (await this.prepara(v))) {
      const b = await readFile(join(this.d.cartella, nome)).catch(() => null)
      if (b) return b
    }
    return readFile(join(this.d.pannello, def.base)).catch(() => null)
  }

  private prepara(v: string): Promise<boolean> {
    if (v === this.chiaveFatta) return Promise.resolve(true)
    if (v === this.fallitaPer) return Promise.resolve(false)
    this.inCorso ??= this.fai(v).finally(() => (this.inCorso = null))
    return this.inCorso
  }

  private async fai(v: string): Promise<boolean> {
    const logo = this.d.logo()
    if (!logo) return false
    const tmp = join(this.d.cartella, `.nuove-${process.pid}`)
    try {
      await rm(tmp, { recursive: true, force: true })
      await mkdir(tmp, { recursive: true })
      for (const [nome, def] of Object.entries(ICONE)) {
        await this.ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', logo, '-vf', filtroIcona(def.lato, def.parte), '-frames:v', '1', join(tmp, nome)])
      }
      for (const nome of Object.keys(ICONE)) await rename(join(tmp, nome), join(this.d.cartella, nome))
      this.chiaveFatta = v
      this.d.log?.('[app] icone del player rifatte dal logo')
      return true
    } catch (e) {
      this.fallitaPer = v
      this.d.log?.(`[app] icone dal logo non riuscite, uso quelle di base: ${(e as Error).message}`)
      return false
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  private ffmpeg(args: string[]): Promise<void> {
    return new Promise((ok, ko) => {
      execFile(this.d.ffmpeg ?? 'ffmpeg', args, { timeout: 20_000 }, (err, _out, errOut) => (err ? ko(new Error(String(errOut || err.message).trim().slice(0, 200))) : ok()))
    })
  }
}
