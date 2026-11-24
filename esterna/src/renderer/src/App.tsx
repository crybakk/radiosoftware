import { useEffect, useMemo, useRef, useState } from 'react'
import type { AggiornamentoStato, Impostazioni, ImpostazioniMixer, StatoServer } from '../../shared/api'
import { Motore } from './motore'
import { Diretta } from './Diretta'
import { ImpostazioniView } from './ImpostazioniView'

const api = window.esterna

export const testoErrore = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function Accesso({ imp, onFatto }: { imp: Impostazioni; onFatto: (i: Impostazioni) => void }) {
  const [server, setServer] = useState(imp.server.replace(/^https:\/\//, ''))
  const [utente, setUtente] = useState(imp.utente)
  const [password, setPassword] = useState('')
  const [errore, setErrore] = useState<string | null>(null)
  const [attesa, setAttesa] = useState(false)
  return (
    <div className="accesso">
      <h1>📡 Radio Esterna</h1>
      <p>Entra con il tuo utente del pannello della radio (conduttore o amministratore).</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setErrore(null)
          setAttesa(true)
          api
            .accedi(server, utente, password)
            .then(onFatto)
            .catch((x: unknown) => setErrore(testoErrore(x)))
            .finally(() => setAttesa(false))
        }}
      >
        <label>
          Indirizzo della radio
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="radio.esempio.it" autoFocus required />
          <small>Lo stesso del pannello, senza https:// (per esempio player.radioattivainformazione.it:9443 durante le prove).</small>
        </label>
        <label>
          Nome
          <input value={utente} onChange={(e) => setUtente(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <button className="primario" disabled={attesa}>
          {attesa ? 'Entro…' : 'Entra'}
        </button>
        {errore && <div className="errore">{errore}</div>}
      </form>
    </div>
  )
}

type Scheda = 'diretta' | 'regia' | 'impostazioni'

export function App() {
  const [imp, setImp] = useState<Impostazioni | null>(null)
  const [stato, setStato] = useState<StatoServer | null>(null)
  const [scheda, setScheda] = useState<Scheda>('diretta')
  const [agg, setAgg] = useState<AggiornamentoStato | null>(null)
  const motore = useMemo(() => new Motore(), [])
  const avviato = useRef(false)

  useEffect(() => {
    void api.impostazioni().then(setImp)
    void api.stato().then(setStato)
    void api.aggiornamento().then(setAgg)
    const off = [api.onStato(setStato), api.onAggiornamento(setAgg), api.onRiavviaInvio(() => motore.riavviaInvio())]
    const offPezzi = api.onPezzi((on) => (on ? motore.avviaRegistrazione() : motore.fermaRegistrazione()))
    const t = setInterval(() => motore.controllaRitorno(), 5000)
    return () => {
      for (const f of off) f()
      offPezzi()
      clearInterval(t)
    }
  }, [motore])

  // il mixer parte appena ci sono le impostazioni (sul Mac prima si chiede il permesso del microfono)
  useEffect(() => {
    if (!imp || avviato.current) return
    avviato.current = true
    void api
      .permessoMicrofono()
      .catch(() => true)
      .then(() => motore.applica(imp.mixer))
      .then(() => motore.avviaInvio())
  }, [imp, motore])

  useEffect(() => {
    motore.setRitornoUrl(stato?.ritornoUrl ?? null)
  }, [stato?.ritornoUrl, motore])

  if (!imp) return null
  if (!imp.accesso) return <Accesso imp={imp} onFatto={setImp} />

  const cambiaMixer = (m: ImpostazioniMixer): void => {
    setImp({ ...imp, mixer: m })
    void api.salvaMixer(m)
    void motore.applica(m)
  }

  const e = stato?.esterna
  const inOnda = !!e?.inOnda
  const collegato = stato?.collegamento === 'collegato'
  return (
    <div className={`app ${inOnda ? 'in-onda' : ''}`}>
      <header>
        <div className="titolo">📡 Radio Esterna {stato?.stazione && <span className="stazione">· {stato.stazione}</span>}</div>
        <div className={`pill ${collegato ? 'ok' : 'off'}`} title={stato?.messaggio}>
          {collegato ? `Server collegato${stato?.kbps ? ` · ${stato.kbps} kbit/s` : ''}` : stato?.collegamento === 'collegamento' ? 'Collegamento…' : 'Server non collegato'}
        </div>
        <div className={`pill ${stato?.regia ? 'ok' : 'off'}`}>{stato?.regia ? 'Regia collegata' : 'Regia non collegata'}</div>
        <nav>
          <button className={scheda === 'diretta' ? 'attiva' : ''} onClick={() => setScheda('diretta')}>
            🎙 Diretta
          </button>
          <button className={scheda === 'regia' ? 'attiva' : ''} onClick={() => setScheda('regia')} disabled={!stato?.pannelloUrl}>
            🎚 Regia
          </button>
          <button className={scheda === 'impostazioni' ? 'attiva' : ''} onClick={() => setScheda('impostazioni')}>
            ⚙ Impostazioni{agg?.stato === 'disponibile' || agg?.stato === 'pronto' ? ' •' : ''}
          </button>
        </nav>
      </header>
      {stato && stato.collegamento !== 'collegato' && (
        <div className={`banner ${stato.caduto ? 'grave' : ''}`}>
          {stato.caduto ? '⚠ Collegamento caduto mentre eri in onda: la radio è tornata alla regia. ' : ''}
          {stato.messaggio}
          {stato.collegamento === 'errore' && stato.messaggio.includes('entra di nuovo') && (
            <button className="piccolo" onClick={() => void api.esci().then(setImp)}>
              Entra di nuovo
            </button>
          )}
        </div>
      )}
      <main className={scheda === 'regia' ? 'regia' : ''}>
        <div hidden={scheda !== 'diretta'}>
          <Diretta imp={imp} setImp={setImp} stato={stato} motore={motore} cambiaMixer={cambiaMixer} />
        </div>
        {scheda === 'regia' && stato?.pannelloUrl && <webview className="pannello" src={stato.pannelloUrl} />}
        {scheda === 'impostazioni' && <ImpostazioniView imp={imp} setImp={setImp} agg={agg} cambiaMixer={cambiaMixer} />}
      </main>
    </div>
  )
}
