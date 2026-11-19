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
import { confrontaVersioni, valuta, type NovitaVersione } from './novita.ts'

export { confrontaVersioni }
export const REPO = 'crybakk/radiosoftware'
const VERSIONE = /^\d+\.\d+\.\d+$/

/** Ultima versione pubblicata tra le release (anche anteprime) con lo ZIP del server, o null. */
export function ultimaVersione(release: unknown): string | null {
  return valuta(release, '', 'server').ultima
}

export interface StatoAggiornamento {
  /** versione installata ('' se non si sa: server installato a mano da un clone) */
  attuale: string
  ultima: string | null
  /** c'è una versione più nuova che cambia il server (le versioni che cambiano solo la regia non contano) */
  disponibile: boolean
  /** cosa cambia nel server con l'aggiornamento (dalla versione più recente) */
  novita: NovitaVersione[]
  /** c'è una versione più nuova, ma cambia solo la regia: il server non ha bisogno di aggiornarsi */
  soloRegia: boolean
  /** novità dell'ultimo aggiornamento installato, finché un amministratore non preme "Ho letto" */
  novitaInstallate?: { da: string; a: string; novita: NovitaVersione[] }
  /** aggiornamento chiesto e non ancora finito */
  inCorso: boolean
  servizioAssente: boolean
  esito?: { quando: string; ok: boolean; messaggio: string }
  controllato?: string
  /** errore dell'ultimo controllo con GitHub, se non è riuscito */
  erroreControllo?: string
}

interface NovitaSalvate {
  da: string
  a: string
  novita: NovitaVersione[]
}

export class AggiornamentoServer {
  private release: unknown = null
  private controllato?: string
  private erroreControllo?: string
  private readonly attuale: string
  private readonly cartella: string
  /** file con le novità dell'aggiornamento chiesto, per mostrarle quando il server è ripartito */
  private readonly fileNovita: string
  private readonly scarica: (url: string) => Promise<unknown>
  private readonly now: () => number

  constructor(opz: { attuale: string; cartellaRichieste: string; fileNovita?: string; scarica?: (url: string) => Promise<unknown>; now?: () => number }) {
    this.attuale = VERSIONE.test(opz.attuale) ? opz.attuale : ''
    this.cartella = opz.cartellaRichieste
    this.fileNovita = opz.fileNovita ?? join(opz.cartellaRichieste, 'novita-aggiornamento.json')
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
      const release = await this.scarica(`https://api.github.com/repos/${REPO}/releases?per_page=30`)
      if (!Array.isArray(release)) throw new Error('risposta di GitHub non valida')
      this.release = release
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
    const v = valuta(this.release, this.attuale, 'server')
    return {
      attuale: this.attuale,
      ultima: v.ultima,
      disponibile: !!v.ultima && v.daAggiornare,
      novita: v.daAggiornare ? v.novita.slice(0, 15) : [],
      soloRegia: !!v.ultima && !!this.attuale && confrontaVersioni(v.ultima, this.attuale) > 0 && !v.daAggiornare,
      novitaInstallate: this.novitaInstallate(),
      inCorso,
      // il servizio sul server toglie subito la richiesta: se resta più di un minuto, il servizio non c'è
      servizioAssente: existsSync(richiesta) && this.now() - statSync(richiesta).mtimeMs > 60_000,
      esito,
      controllato: this.controllato,
      erroreControllo: this.erroreControllo
    }
  }

  /** Lascia la richiesta di aggiornare all'ultima versione (e si segna le novità da mostrare dopo). */
  chiedi(versione: string): void {
    if (!VERSIONE.test(versione)) throw new Error('versione non valida')
    const v = valuta(this.release, this.attuale, 'server')
    if (versione !== v.ultima) throw new Error(`la versione ${versione} non è l'ultima pubblicata`)
    try {
      const salvate: NovitaSalvate = { da: this.attuale, a: versione, novita: v.novita.slice(0, 15) }
      writeFileSync(this.fileNovita, JSON.stringify(salvate))
    } catch (e) {
      // senza le novità l'aggiornamento si fa lo stesso
      console.log(`novità dell'aggiornamento non salvate: ${(e as Error).message}`)
    }
    writeFileSync(join(this.cartella, 'aggiorna'), versione + '\n')
  }

  /** Novità dell'ultimo aggiornamento, solo se il server è davvero ripartito con una versione diversa. */
  private novitaInstallate(): NovitaSalvate | undefined {
    try {
      const n = JSON.parse(readFileSync(this.fileNovita, 'utf8')) as NovitaSalvate
      if (!this.attuale || this.attuale === n.da || !Array.isArray(n.novita)) return undefined
      return { da: n.da, a: this.attuale, novita: n.novita }
    } catch {
      return undefined
    }
  }

  /** "Ho letto": le novità dell'ultimo aggiornamento non si mostrano più. */
  novitaLette(): void {
    try {
      unlinkSync(this.fileNovita)
    } catch {
      // già tolte
    }
  }

  annulla(): void {
    try {
      unlinkSync(join(this.cartella, 'aggiorna'))
    } catch {
      // già tolta
    }
  }
}
