import { useEffect, useState } from 'react'
import type { AggiornamentoStato, Impostazioni, ImpostazioniMixer } from '../../shared/api'
import { testoErrore } from './App'
import { ConfermaBottone } from './Conferma'

const api = window.esterna

/**
 * Impostazioni a prova di anziano (27/11/2026), come la regia: prima le cose di tutti i giorni, le regolazioni
 * tecniche solo con l'interruttore "Avanzate" in fondo.
 */
export function ImpostazioniView({
  imp,
  setImp,
  agg,
  cambiaMixer,
  inOnda
}: {
  imp: Impostazioni
  setImp: (i: Impostazioni) => void
  agg: AggiornamentoStato | null
  cambiaMixer: (m: ImpostazioniMixer) => void
  inOnda: boolean
}) {
  const [versione, setVersione] = useState('')
  const [errore, setErrore] = useState<string | null>(null)
  useEffect(() => {
    void api.versione().then(setVersione)
  }, [])
  const aspetto = (a: { testoGrande?: boolean; mostraAvanzate?: boolean }): void => void api.aspetto(a).then(setImp)
  const nuova = agg?.stato === 'disponibile' || agg?.stato === 'pronto' || agg?.stato === 'scarico'
  return (
    <div className="impostazioni">
      <section className="riquadro">
        <h2>👤 Chi sei</h2>
        <p>
          Sei entrato come <b>{imp.utente}</b> nella radio <b>{imp.server.replace(/^https:\/\//, '')}</b>.
        </p>
        <ConfermaBottone domanda="Uscire? Per rientrare servono di nuovo nome e password." si="Sì, esci" onSi={() => void api.esci().then(setImp)} disabled={inOnda}>
          Esci
        </ConfermaBottone>
        {inOnda && <p className="nota">Per uscire prima vai FUORI ONDA.</p>}
      </section>

      <section className="riquadro">
        <h2>🔎 Scritte</h2>
        <label className="interruttore">
          <input type="checkbox" checked={imp.testoGrande} onChange={(e) => aspetto({ testoGrande: e.target.checked })} /> Testo grande
        </label>
        <p className="nota">Ingrandisce scritte e pulsanti di tutta l'app.</p>
      </section>

      <section className="riquadro">
        <h2>🔄 Aggiornamenti</h2>
        <p>Versione installata: {versione}</p>
        {nuova ? (
          <>
            <p>
              <b>C'è una versione nuova ({agg.versione}).</b> Ecco cosa cambia:
            </p>
            {agg.novita?.map((n) => (
              <div key={n.versione} className="novita">
                <b>{n.versione}</b>
                <ul>
                  {n.novita.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            ))}
            <button
              className="primario"
              disabled={agg.stato === 'scarico' || inOnda}
              onClick={() => {
                setErrore(null)
                api.installaAggiornamento().catch((e: unknown) => setErrore(testoErrore(e)))
              }}
            >
              {agg.stato === 'scarico' ? `Scarico… ${agg.percentuale ?? 0}%` : api.piattaforma === 'darwin' ? 'Scarica la versione nuova' : 'Aggiorna adesso'}
            </button>
            {inOnda ? (
              <p className="nota">Mentre sei in onda non si aggiorna: prima vai FUORI ONDA.</p>
            ) : (
              <p className="nota">
                {api.piattaforma === 'darwin'
                  ? 'Si scarica un file: aprilo e trascina Radio Esterna in Applicazioni, come la prima volta.'
                  : "L'app si chiude e si riapre da sola, in circa un minuto."}
              </p>
            )}
          </>
        ) : (
          <p className="nota">Hai già l'ultima versione.</p>
        )}
        {agg?.errore && <div className="errore">{agg.errore}</div>}
        {errore && <div className="errore">{errore}</div>}
        <button onClick={() => void api.controllaAggiornamenti()}>Controlla se ci sono aggiornamenti</button>
        {imp.mostraAvanzate && agg?.controllo && <p className="nota">Ultimo controllo: {agg.controllo}</p>}
      </section>

      <section className="riquadro">
        <h2>📖 Guida</h2>
        <button onClick={() => void api.apriGuida()}>Apri la guida</button>
      </section>

      {imp.mostraAvanzate && (
        <>
          <section className="riquadro">
            <h2>Qualità dell'invio</h2>
            <select value={imp.mixer.kbps} onChange={(e) => cambiaMixer({ ...imp.mixer, kbps: Number(e.target.value) as ImpostazioniMixer['kbps'] })}>
              <option value={96}>Internet molto lento (96 kbit/s, circa 45 MB all'ora)</option>
              <option value={128}>Internet lento (128 kbit/s, circa 60 MB all'ora)</option>
              <option value={160}>Normale, consigliata (160 kbit/s, circa 75 MB all'ora)</option>
              <option value={256}>Internet ottimo (256 kbit/s, circa 115 MB all'ora)</option>
            </select>
            <p className="nota">Se l'audio salta spesso, scegli una qualità più bassa.</p>
          </section>
          <section className="riquadro">
            <h2>Registrazioni solo sul computer</h2>
            <p>
              Cartella: <b>{imp.cartellaRegistrazioni}</b>
            </p>
            <div className="riga">
              <button onClick={() => void api.scegliCartella().then(setImp)}>Cambia cartella</button>
              <button onClick={() => void api.apriCartella()}>Apri</button>
            </div>
          </section>
        </>
      )}

      <section className="riquadro">
        <h2>⚙ Avanzate</h2>
        <label className="interruttore">
          <input type="checkbox" checked={imp.mostraAvanzate} onChange={(e) => aspetto({ mostraAvanzate: e.target.checked })} /> Mostra le regolazioni avanzate
        </label>
        <p className="nota">Qualità dell'invio, cartella delle registrazioni, ingressi della scheda audio, volumi in dB e dettagli della linea. Di solito non servono.</p>
      </section>
    </div>
  )
}
