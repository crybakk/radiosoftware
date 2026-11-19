/**
 * Aggiornamento della regia dalle release di GitHub (OTA), solo a richiesta.
 *
 * Controlla all'avvio e poi ogni 6 ore se c'è una versione nuova e lo dice alla finestra; non scarica
 * e non installa niente da solo. Quando si preme "Aggiorna" scarica l'installer (solo le parti cambiate,
 * quando si può) e riavvia la regia con la versione nuova.
 *
 * Dalle note delle release (vedi ponte/controllo/src/novita.ts) legge cosa cambia nella regia: lo mostra prima di
 * aggiornare e alla prima apertura dopo l'aggiornamento. Se le versioni nuove cambiano solo il server, la regia
 * non propone di aggiornarsi.
 */
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { valuta } from '../../ponte/controllo/src/novita.ts'
import type { AggiornamentoStato, NovitaInstallate } from '../shared/api'

const { autoUpdater } = electronUpdater
const OGNI = 6 * 3600_000
const RELEASE_URL = 'https://api.github.com/repos/crybakk/radiosoftware/releases?per_page=30'

/** Elenco delle release da GitHub (senza chiave: 60 richieste l'ora bastano, si controlla ogni 6 ore). */
async function scaricaRelease(): Promise<unknown> {
  const r = await fetch(RELEASE_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'radio-regia' }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`GitHub ha risposto ${r.status}`)
  return r.json()
}

export class Aggiornamenti {
  private stato: AggiornamentoStato = { stato: 'nessuno', attuale: app.getVersion() }
  private readonly avvisa: (s: AggiornamentoStato) => void
  /** valutazione in corso delle note delle release, dopo che electron-updater ha trovato una versione nuova */
  private valutazione: Promise<void> | null = null

  constructor(avvisa: (s: AggiornamentoStato) => void) {
    this.avvisa = avvisa
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    // le release automatiche sono segnate come anteprima
    autoUpdater.allowPrerelease = true
    autoUpdater.on('update-available', (i) => {
      this.valutazione = this.valuta(i.version)
    })
    autoUpdater.on('update-not-available', () => {
      if (this.stato.stato !== 'scarico') this.cambia({ stato: 'nessuno', novita: undefined, soloServer: undefined })
    })
    autoUpdater.on('download-progress', (p) => this.cambia({ stato: 'scarico', percentuale: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (i) => this.cambia({ stato: 'pronto', versione: i.version }))
    autoUpdater.on('error', (e) => {
      // senza rete o senza release: si riprova al prossimo controllo, senza disturbare
      if (this.stato.stato === 'scarico') this.cambia({ stato: 'errore', errore: e instanceof Error ? e.message : String(e) })
    })
    autoUpdater.on('checking-for-update', () => this.cambia({ controllo: 'in corso' }))
  }

  /** Avvia i controlli periodici (solo nel programma installato). */
  avvia(): void {
    if (!app.isPackaged) return
    setTimeout(() => void this.controlla(), 30_000)
    setInterval(() => void this.controlla(), OGNI)
  }

  /** Controlla subito se c'è una versione nuova (anche dal pulsante in Impostazioni). */
  async controlla(): Promise<AggiornamentoStato> {
    if (!app.isPackaged) {
      this.cambia({ controllo: 'non installato' })
      return this.stato
    }
    try {
      this.valutazione = null
      await autoUpdater.checkForUpdates()
      await this.valutazione
      this.cambia({ controllo: 'ok', controllato: new Date().toISOString() })
    } catch (e) {
      this.cambia({ controllo: `non riuscito: ${e instanceof Error ? e.message : String(e)}`, controllato: new Date().toISOString() })
    }
    return this.stato
  }

  /** C'è la versione `versione`: la propone solo se cambia la regia, con le sue novità. */
  private async valuta(versione: string): Promise<void> {
    // mentre scarica o è già pronta non si cambia niente
    if (this.stato.stato === 'scarico' || this.stato.stato === 'pronto') return
    try {
      const v = valuta(await scaricaRelease(), app.getVersion(), 'regia')
      if (!v.daAggiornare) {
        this.cambia({ stato: 'nessuno', novita: undefined, soloServer: versione })
        return
      }
      this.cambia({ stato: 'disponibile', versione, novita: v.novita.slice(0, 15), soloServer: undefined })
    } catch {
      // senza le note (GitHub non risponde) si propone lo stesso, senza l'elenco delle novità
      this.cambia({ stato: 'disponibile', versione, novita: undefined, soloServer: undefined })
    }
  }

  private get fileNovita(): string {
    return join(app.getPath('userData'), 'novita-aggiornamento.json')
  }

  /** Novità dell'aggiornamento appena installato, se la regia è ripartita con una versione diversa. */
  novitaInstallate(): NovitaInstallate | null {
    try {
      const n = JSON.parse(readFileSync(this.fileNovita, 'utf8')) as NovitaInstallate
      if (n.da === app.getVersion() || !Array.isArray(n.novita)) return null
      return { da: n.da, a: app.getVersion(), novita: n.novita }
    } catch {
      return null
    }
  }

  /** "Ho letto": le novità non si mostrano più. */
  novitaLette(): void {
    try {
      unlinkSync(this.fileNovita)
    } catch {
      // già tolte
    }
  }

  get(): AggiornamentoStato {
    return this.stato
  }

  /** Scarica la versione nuova e riavvia la regia per installarla. */
  async installa(): Promise<void> {
    if (!app.isPackaged) throw new Error('Il programma non è installato: aggiornalo dal codice')
    if (this.stato.stato !== 'pronto') {
      this.cambia({ stato: 'scarico', percentuale: 0 })
      await autoUpdater.downloadUpdate()
    }
    // le novità si mostrano alla prima apertura con la versione nuova
    try {
      const n: NovitaInstallate = { da: app.getVersion(), a: this.stato.versione ?? '', novita: this.stato.novita ?? [] }
      writeFileSync(this.fileNovita, JSON.stringify(n))
    } catch {
      // senza le novità si aggiorna lo stesso
    }
    // installazione silenziosa e riapertura della regia
    autoUpdater.quitAndInstall(true, true)
  }

  private cambia(s: Partial<AggiornamentoStato>): void {
    const versione = s.versione ?? (s.stato === 'nessuno' ? undefined : this.stato.versione)
    this.stato = {
      novita: 'novita' in s ? s.novita : this.stato.novita,
      soloServer: 'soloServer' in s ? s.soloServer : this.stato.soloServer,
      attuale: app.getVersion(),
      stato: s.stato ?? this.stato.stato,
      versione,
      percentuale: s.percentuale,
      errore: s.errore,
      controllo: s.controllo ?? this.stato.controllo,
      controllato: s.controllato ?? this.stato.controllato
    }
    this.avvisa(this.stato)
  }
}
