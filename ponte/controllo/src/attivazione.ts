/**
 * Attivazione del server: finché non c'è una chiave valida (CHIAVE_ATTIVAZIONE nel file .env) il pannello,
 * il player e le API rispondono solo con la pagina per incollarla. La chiave incollata si salva nel .env,
 * così vale anche dopo un riavvio.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { aggiornaEnv } from './impostazioni.ts'
import { verificaChiave, type EsitoChiave } from './licenza.ts'

export class Attivazione {
  private esito: EsitoChiave
  private readonly fileEnv: string

  constructor(chiave: string | undefined, fileEnv: string) {
    this.esito = verificaChiave(chiave)
    this.fileEnv = fileEnv
  }

  attivo(): boolean {
    return this.esito.ok
  }

  /** Nome della radio scritto nella chiave ('' se non attivo). */
  radio(): string {
    return this.esito.ok ? this.esito.radio : ''
  }

  /** Prova una chiave incollata: se è valida la salva nel .env e attiva il server. */
  attiva(chiave: string): EsitoChiave {
    const esito = verificaChiave(chiave)
    if (!esito.ok) return esito
    const pulita = chiave.replace(/\s+/g, '')
    if (existsSync(this.fileEnv)) {
      writeFileSync(this.fileEnv, aggiornaEnv(readFileSync(this.fileEnv, 'utf8'), { CHIAVE_ATTIVAZIONE: pulita }))
    }
    process.env.CHIAVE_ATTIVAZIONE = pulita
    this.esito = esito
    return esito
  }
}

export const PAGINA_ATTIVAZIONE = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Attiva il server</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111418; color: #e8eaed; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { max-width: 520px; padding: 24px; }
  h1 { font-size: 1.4rem; }
  textarea { width: 100%; box-sizing: border-box; min-height: 110px; font-family: monospace; font-size: .9rem; background: #1c2128; color: inherit; border: 1px solid #3a414b; border-radius: 8px; padding: 10px; }
  button { margin-top: 12px; font-size: 1rem; padding: 10px 18px; border-radius: 8px; border: 0; background: #2f81f7; color: #fff; cursor: pointer; }
  #esito { margin-top: 12px; min-height: 1.4em; }
  .errore { color: #ff7b72; } .ok { color: #3fb950; }
</style>
</head>
<body>
<main>
  <h1>Attiva il server della radio</h1>
  <p>Incolla qui la chiave di attivazione (inizia con <code>RADIO1.</code>). È la stessa della regia.</p>
  <textarea id="chiave" spellcheck="false" autofocus></textarea>
  <button id="attiva">Attiva</button>
  <div id="esito"></div>
</main>
<script>
  const esito = document.getElementById('esito')
  document.getElementById('attiva').onclick = async () => {
    esito.className = ''; esito.textContent = 'Controllo...'
    try {
      const r = await fetch('/api/attivazione', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chiave: document.getElementById('chiave').value }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'errore')
      esito.className = 'ok'; esito.textContent = 'Server attivato per ' + j.radio + '. Un attimo...'
      setTimeout(() => location.reload(), 1200)
    } catch (e) { esito.className = 'errore'; esito.textContent = e.message }
  }
</script>
</body>
</html>
`
