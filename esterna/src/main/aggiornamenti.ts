/**
 * Aggiornamenti di Radio Esterna dalle release di GitHub, solo a richiesta (come la regia).
 *
 * - Windows: electron-updater sul canale "esterna" (file esterna.yml della release, separato da latest.yml della
 *   regia). La versione da prendere la sceglie l'app dalle note delle release; poi electron-updater legge
 *   esterna.yml proprio da quella release (fornitore "generic": quello di GitHub non sa scegliere un canale
 *   con un nome suo). "Aggiorna" scarica e riavvia l'app con la versione nuova.
 * - Mac: senza un account Apple Developer l'app non è firmata e non si può aggiornare da sola; "Scarica"
 *   apre il file .dmg della versione nuova, da installare come la prima volta.
 * Se le versioni nuove non cambiano l'app (solo regia o server) non propone niente.
 */
import { app, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { valuta, confrontaVersioni } from '../../../ponte/controllo/src/novita.ts'
import { dmgDaRelease } from './release'
import type { AggiornamentoStato } from '../shared/api'

const { autoUpdater } = electronUpdater
const OGNI = 6 * 3600_000
const RELEASE_URL = 'https://api.github.com/repos/crybakk/radiosoftware/releases?per_page=30'

async function scaricaRelease(): Promise<unknown> {
  const r = await fetch(RELEASE_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'radio-esterna' }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error('non riesco a controllare: riprova più tardi')
  return r.json()
}

export class Aggiornamenti {
  private stato: AggiornamentoStato = { stato: 'nessuno', attuale: app.getVersion() }
  private readonly avvisa: (s: AggiornamentoStato) => void
  private readonly mac = process.platform === 'darwin'

  constructor(avvisa: (s: AggiornamentoStato) => void) {
    this.avvisa = avvisa
    if (this.mac) return
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowDowngrade = false
    autoUpdater.on('download-progress', (p) => this.cambia({ stato: 'scarico', percentuale: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (i) => this.cambia({ stato: 'pronto', versione: i.version }))
    autoUpdater.on('error', (e) => {
      if (this.stato.stato === 'scarico') this.cambia({ stato: 'errore', errore: e instanceof Error ? e.message : String(e) })
    })
  }

  avvia(): void {
    if (!app.isPackaged) return
    setTimeout(() => void this.controlla(), 30_000)
    setInterval(() => void this.controlla(), OGNI)
  }

  get(): AggiornamentoStato {
    return this.stato
  }

  async controlla(): Promise<AggiornamentoStato> {
    if (!app.isPackaged) {
      this.cambia({ controllo: 'programma non installato' })
      return this.stato
    }
    if (this.stato.stato === 'scarico' || this.stato.stato === 'pronto') return this.stato
    try {
      const release = await scaricaRelease()
      const v = valuta(release, app.getVersion(), 'esterna')
      if (!v.daAggiornare || !v.ultima || confrontaVersioni(v.ultima, app.getVersion()) <= 0) {
        this.cambia({ stato: 'nessuno', versione: undefined, novita: undefined, scarica: undefined, controllo: `ok, ${new Date().toLocaleString('it-IT')}` })
        return this.stato
      }
      if (this.mac) {
        this.cambia({ stato: 'disponibile', versione: v.ultima, novita: v.novita.slice(0, 15), scarica: dmgDaRelease(release, v.ultima) ?? undefined, controllo: 'ok' })
      } else {
        // esterna.yml della release scelta (latest.yml è quello della regia)
        autoUpdater.setFeedURL({ provider: 'generic', url: `https://github.com/crybakk/radiosoftware/releases/download/v${v.ultima}`, channel: 'esterna' })
        const r = await autoUpdater.checkForUpdates()
        const versione = r?.updateInfo?.version ?? v.ultima
        this.cambia({ stato: 'disponibile', versione, novita: v.novita.slice(0, 15), controllo: 'ok' })
      }
    } catch (e) {
      this.cambia({ controllo: `non riuscito: ${e instanceof Error ? e.message : String(e)}` })
    }
    return this.stato
  }

  async installa(): Promise<void> {
    if (!app.isPackaged) throw new Error('Il programma non è installato')
    if (this.mac) {
      if (!this.stato.scarica) throw new Error('Il file per il Mac non è ancora pronto: riprova tra qualche minuto.')
      await shell.openExternal(this.stato.scarica)
      return
    }
    if (this.stato.stato !== 'pronto') {
      this.cambia({ stato: 'scarico', percentuale: 0 })
      await autoUpdater.downloadUpdate()
    }
    autoUpdater.quitAndInstall(true, true)
  }

  private cambia(p: Partial<AggiornamentoStato>): void {
    this.stato = { ...this.stato, ...p, attuale: app.getVersion() }
    this.avvisa(this.stato)
  }
}
