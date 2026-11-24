/**
 * Chiave di attivazione della regia: senza una chiave valida il programma installato non parte.
 * La chiave (la stessa del server) si incolla una volta in una piccola finestra e si salva
 * nella cartella dati. Chi avvia il programma dal codice sorgente (non installato) non la deve inserire.
 */
import { app, BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verificaChiave } from '../../ponte/controllo/src/licenza.ts'

const FILE = 'chiave-attivazione.txt'
const SEGNALE = 'CHIAVE:'

const pagina = (nome: string): string => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Attiva ${nome}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
body{font-family:system-ui,sans-serif;background:#111418;color:#e8eaed;margin:0;padding:24px}
h1{font-size:1.3rem;margin-top:0}
textarea{width:100%;box-sizing:border-box;height:110px;font-family:monospace;background:#1c2128;color:inherit;border:1px solid #3a414b;border-radius:8px;padding:10px}
button{margin-top:12px;font-size:1rem;padding:10px 18px;border-radius:8px;border:0;background:#2f81f7;color:#fff;cursor:pointer}
#esito{margin-top:12px;color:#ff7b72;min-height:1.4em}
</style></head><body>
<h1>Attiva ${nome}</h1>
<p>Incolla la chiave di attivazione (inizia con <code>RADIO1.</code>). È la stessa del server.</p>
<textarea id="chiave" spellcheck="false" autofocus></textarea>
<button id="attiva">Attiva</button>
<div id="esito"></div>
<script>
let n = 0
document.getElementById('attiva').onclick = () => {
  document.getElementById('esito').textContent = ''
  // il valore passa al programma dal titolo della pagina (la finestra non ha altri accessi)
  document.title = '${SEGNALE}' + (n++) + ':' + document.getElementById('chiave').value
}
window.mostraErrore = (m) => { document.getElementById('esito').textContent = m; document.title = 'Attiva ${nome}' }
</script></body></html>`

/**
 * true se il programma può partire (chiave già salvata, appena inserita, o programma non installato).
 * Usato dalla regia e dall'app Radio Esterna (`nome` = nome nella finestra).
 */
export function controllaAttivazione(cartellaDati: string, nome = 'Radio Regia'): Promise<boolean> {
  if (!app.isPackaged) return Promise.resolve(true)
  const file = join(cartellaDati, FILE)
  if (existsSync(file) && verificaChiave(readFileSync(file, 'utf8')).ok) return Promise.resolve(true)
  return new Promise((resolve) => {
    let attivata = false
    const w = new BrowserWindow({
      width: 560,
      height: 380,
      resizable: false,
      title: `Attiva ${nome}`,
      backgroundColor: '#111418',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, javascript: true }
    })
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.webContents.on('will-navigate', (e) => e.preventDefault())
    w.on('page-title-updated', (e, titolo) => {
      if (!titolo.startsWith(SEGNALE)) return
      e.preventDefault()
      const chiave = titolo.slice(titolo.indexOf(':', SEGNALE.length) + 1)
      const esito = verificaChiave(chiave)
      if (!esito.ok) {
        void w.webContents.executeJavaScript(`mostraErrore(${JSON.stringify(esito.errore)})`)
        return
      }
      writeFileSync(file, chiave.replace(/\s+/g, '') + '\n')
      attivata = true
      w.hide()
      // si chiude solo quando c'è la finestra del programma: altrimenti, senza finestre, il programma uscirebbe
      app.once('browser-window-created', () => setImmediate(() => w.destroy()))
      resolve(true)
    })
    w.on('closed', () => {
      if (!attivata) resolve(false)
    })
    void w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pagina(nome)))
  })
}
