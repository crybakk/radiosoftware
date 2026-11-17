/**
 * Aggiornamento del server dalle release di GitHub (OTA), solo a richiesta.
 *
 * Il servizio di controllo guarda ogni 6 ore qual è l'ultima release e il pannello lo mostra agli
 * amministratori. Quando si preme "Aggiorna server" lascia la richiesta "aggiorna" (con il numero di
 * versione) nella cartella condivisa: sul server il servizio radio-ponte-aggiorna (sistema/aggiorna-server.sh)
 * scarica lo ZIP della release, controlla l'impronta e rilancia installa-server.sh.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const REPO = 'crybakk/radiosoftware'
const VERSIONE = /^\d+\.\d+\.\d+$/

/** Confronta due versioni a.b.c: negativo se a < b. */
export function confrontaVersioni(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** Ultima versione pubblicata tra le release (anche anteprime), o null. */
export function ultimaVersione(release: unknown): string | null {
  if (!Array.isArray(release)) return null
  let max: string | null = null
  for (const r of release as { tag_name?: unknown; draft?: unknown; assets?: { name?: unknown }[] }[]) {
    if (r.draft || typeof r.tag_name !== 'string') continue
    const v = r.tag_name.replace(/^v/, '')
    if (!VERSIONE.test(v)) continue
    // solo release con lo ZIP del server
    if (!r.assets?.some((a) => a.name === `RadioPonte-server-${v}.zip`)) continue
    if (!max || confrontaVersioni(v, max) > 0) max = v
  }
  return max
}

export interface StatoAggiornamento {
  /** versione installata ('' se non si sa: server installato a mano da un clone) */
  attuale: string
  ultima: string | null
  disponibile: boolean
  /** aggiornamento chiesto e non ancora finito */
  inCorso: boolean
  servizioAssente: boolean
  esito?: { quando: string; ok: boolean; messaggio: string }
  controllato?: string
  /** errore dell'ultimo controllo con GitHub, se non è riuscito */
  erroreControllo?: string
}

export class AggiornamentoServer {
  private ultima: string | null = null
  private controllato?: string
  private erroreControllo?: string
  private readonly attuale: string
  private readonly cartella: string
  private readonly scarica: (url: string) => Promise<unknown>
  private readonly now: () => number

  constructor(opz: { attuale: string; cartellaRichieste: string; scarica?: (url: string) => Promise<unknown>; now?: () => number }) {
    this.attuale = VERSIONE.test(opz.attuale) ? opz.attuale : ''
    this.cartella = opz.cartellaRichieste
    this.now = opz.now ?? Date.now
    this.scarica =
      opz.scarica ??
      (async (url) => {
        const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'radio-ponte' }, signal: AbortSignal.timeout(20_000) })
        if (!r.ok) throw new Error(`GitHub ha risposto ${r.status}`)
        return r.json()
      })
  }

  /** Chiede a GitHub l'ultima release; gli errori (rete, repository privato) lasciano il valore di prima. */
  async controlla(): Promise<void> {
    try {
      this.ultima = ultimaVersione(await this.scarica(`https://api.github.com/repos/${REPO}/releases?per_page=30`))
      this.erroreControllo = undefined
    } catch (e) {
      this.erroreControllo = (e as Error).message
      console.log(`controllo aggiornamenti non riuscito: ${(e as Error).message}`)
    }
    this.controllato = new Date(this.now()).toISOString()
  }

  avvia(): void {
    void this.controlla()
    setInterval(() => void this.controlla(), 6 * 3600_000).unref()
  }

  stato(): StatoAggiornamento {
    const richiesta = join(this.cartella, 'aggiorna')
    const inCorso = existsSync(richiesta) || existsSync(join(this.cartella, 'aggiornamento-in-corso'))
    let esito: StatoAggiornamento['esito']
    try {
      esito = JSON.parse(readFileSync(join(this.cartella, 'esito-aggiornamento.json'), 'utf8'))
    } catch {
      esito = undefined
    }
    return {
      attuale: this.attuale,
      ultima: this.ultima,
      disponibile: !!this.ultima && (!this.attuale || confrontaVersioni(this.ultima, this.attuale) > 0),
      inCorso,
      // il servizio sul server toglie subito la richiesta: se resta più di un minuto, il servizio non c'è
      servizioAssente: existsSync(richiesta) && this.now() - statSync(richiesta).mtimeMs > 60_000,
      esito,
      controllato: this.controllato,
      erroreControllo: this.erroreControllo
    }
  }

  /** Lascia la richiesta di aggiornare all'ultima versione. */
  chiedi(versione: string): void {
    if (!VERSIONE.test(versione)) throw new Error('versione non valida')
    if (versione !== this.ultima) throw new Error(`la versione ${versione} non è l'ultima pubblicata`)
    writeFileSync(join(this.cartella, 'aggiorna'), versione + '\n')
  }

  annulla(): void {
    try {
      unlinkSync(join(this.cartella, 'aggiorna'))
    } catch {
      // già tolta
    }
  }
}
