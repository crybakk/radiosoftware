import { useEffect, useState } from 'react'
import type { AggiornamentoStato, Impostazioni, ImpostazioniMixer } from '../../shared/api'
import { testoErrore } from './App'

const api = window.esterna

export function ImpostazioniView({
  imp,
  setImp,
  agg,
  cambiaMixer
}: {
  imp: Impostazioni
  setImp: (i: Impostazioni) => void
  agg: AggiornamentoStato | null
  cambiaMixer: (m: ImpostazioniMixer) => void
}) {
  const [versione, setVersione] = useState('')
  const [errore, setErrore] = useState<string | null>(null)
  useEffect(() => {
    void api.versione().then(setVersione)
  }, [])
  return (
    <div className="impostazioni">
      <section className="riquadro">
        <h2>Server</h2>
        <p>
          Collegato a <b>{imp.server}</b> come <b>{imp.utente}</b>.
        </p>
        <button onClick={() => void api.esci().then(setImp)}>Esci</button>
      </section>
      <section className="riquadro">
        <h2>Qualità dell'invio</h2>
        <select value={imp.mixer.kbps} onChange={(e) => cambiaMixer({ ...imp.mixer, kbps: Number(e.target.value) as ImpostazioniMixer['kbps'] })}>
          <option value={96}>96 kbit/s (rete molto lenta, circa 45 MB all'ora)</option>
          <option value={128}>128 kbit/s (circa 60 MB all'ora)</option>
          <option value={160}>160 kbit/s, consigliata (circa 75 MB all'ora)</option>
          <option value={256}>256 kbit/s (rete buona, circa 115 MB all'ora)</option>
        </select>
        <p className="nota">Opus, la stessa qualità della voce del pannello. Se il collegamento salta spesso, scegli una qualità più bassa.</p>
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
      <section className="riquadro">
        <h2>Aggiornamenti</h2>
        <p>Versione installata: {versione}</p>
        {agg?.stato === 'disponibile' || agg?.stato === 'pronto' || agg?.stato === 'scarico' ? (
          <>
            <p>
              <b>C'è la versione {agg.versione}.</b>
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
              disabled={agg.stato === 'scarico'}
              onClick={() => {
                setErrore(null)
                api.installaAggiornamento().catch((e: unknown) => setErrore(testoErrore(e)))
              }}
            >
              {agg.stato === 'scarico' ? `Scarico… ${agg.percentuale ?? 0}%` : api.piattaforma === 'darwin' ? 'Scarica la versione nuova' : 'Aggiorna'}
            </button>
            {api.piattaforma === 'darwin' && <p className="nota">Sul Mac si scarica il file: aprilo e trascina Radio Esterna in Applicazioni, come la prima volta.</p>}
            <p className="nota">Non aggiornare mentre sei in onda: l'app si chiude e si riapre.</p>
          </>
        ) : (
          <p className="nota">Nessun aggiornamento. {agg?.controllo ? `Ultimo controllo: ${agg.controllo}` : ''}</p>
        )}
        {agg?.errore && <div className="errore">{agg.errore}</div>}
        {errore && <div className="errore">{errore}</div>}
        <button onClick={() => void api.controllaAggiornamenti()}>Controlla aggiornamenti</button>
      </section>
      <section className="riquadro">
        <h2>Guida</h2>
        <button onClick={() => void api.apriGuida()}>📖 Apri la guida</button>
      </section>
    </div>
  )
}
