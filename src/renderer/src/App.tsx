import { PreviewContext } from './VoiceSection'
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { ConnectionView, uplinkClass } from './ConnectionView'
import { EventsView } from './EventsView'
import { GuideView } from './GuideView'
import { hhmmss } from './format'
import { LibraryView } from './LibraryView'
import { LogView } from './LogView'
import { OnAirView } from './OnAirView'
import { SettingsView } from './SettingsView'
import { StatsView } from './StatsView'
import { useRadio } from './useRadio'
import type { AggiornamentoStato, NovitaInstallate, NovitaVersione } from '../../shared/api'

type Tab = 'onair' | 'library' | 'events' | 'log' | 'stats' | 'link' | 'settings' | 'guide'

const TABS: { id: Tab; label: string }[] = [
  { id: 'onair', label: 'In onda' },
  { id: 'library', label: 'Libreria' },
  { id: 'events', label: 'Eventi' },
  { id: 'log', label: 'Registro' },
  { id: 'stats', label: 'Ascoltatori' },
  { id: 'link', label: 'Collegamento' },
  { id: 'settings', label: 'Impostazioni' },
  { id: 'guide', label: 'Guida' }
]

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 250)
    return () => clearInterval(t)
  }, [])
  return <div className="clock">{hhmmss(now)}</div>
}

export function App() {
  const radio = useRadio()
  const [tab, setTab] = useState<Tab>('onair')
  const auto = radio.snapshot.mode === 'auto'
  const onAir = radio.snapshot.onAir.length > 0

  return (
    <PreviewContext.Provider value={radio.preview}>
    <div className="app">
      <header className="topbar">
        <div className={`onair-lamp ${onAir ? 'lit' : ''}`}>{onAir ? 'IN ONDA' : 'FERMO'}</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {radio.settings.ponte.enabled && (
          <button
            className={`link-pill ${radio.ponte?.alarms.length ? 'bad' : uplinkClass(radio.ponte?.uplink.state)}`}
            onClick={() => setTab('link')}
            title={radio.ponte?.uplink.message}
          >
            PONTE: {radio.ponte?.uplink.state === 'collegato' ? 'OK' : radio.ponte?.uplink.state === 'spento' ? 'SPENTO' : 'NON COLLEGATO'}
            {!!radio.ponte?.alarms.length && ` · ${radio.ponte.alarms.length} ALLARMI`}
          </button>
        )}
        <button
          className={`mode ${auto ? 'auto' : 'manual'}`}
          onClick={() => radio.engine.setMode(auto ? 'manual' : 'auto')}
          title="In automatico la regia sceglie e manda in onda i brani da sola"
        >
          {auto ? 'AUTOMATICO' : 'MANUALE'}
        </button>
        <Clock />
      </header>
      {radio.audioError && <div className="banner error">{radio.audioError}</div>}
      <RestoredBanner />
      <NovitaBanner />
      <UpdateBanner />
      {radio.snapshot.lastError && <div className="banner warn">{radio.snapshot.lastError}</div>}
      <main>
        {/* sotto useRadio: un errore in una scheda non smonta App e non ferma la messa in onda */}
        <ViewErrorBoundary key={tab}>
          {tab === 'onair' && <OnAirView radio={radio} />}
          {tab === 'library' && <LibraryView radio={radio} />}
          {tab === 'events' && <EventsView radio={radio} />}
          {tab === 'log' && <LogView />}
          {tab === 'stats' && <StatsView />}
          {tab === 'link' && <ConnectionView radio={radio} />}
          {tab === 'settings' && <SettingsView radio={radio} />}
          {tab === 'guide' && <GuideView />}
        </ViewErrorBoundary>
      </main>
    </div>
    </PreviewContext.Provider>
  )
}

/** Isola gli errori di una scheda: mostra un avviso al posto della scheda invece di smontare tutta l'app. */
class ViewErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Errore nella scheda', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="banner error">
        Questa scheda ha avuto un problema e non può essere mostrata ({this.state.error.message}). La messa in onda
        continua.{' '}
        <button className="small" onClick={() => this.setState({ error: null })}>
          Riprova
        </button>
      </div>
    )
  }
}

/** Elenco delle novità per versione, dalla più recente. */
export function ElencoNovita({ novita }: { novita: NovitaVersione[] }) {
  return (
    <div className="novita">
      {novita.map((v, i) => (
        <details key={v.versione} open={i === 0}>
          <summary>Versione {v.versione}</summary>
          <ul>
            {v.novita.map((n, j) => (
              <li key={j}>{n}</li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  )
}

/** Alla prima apertura dopo un aggiornamento: cosa è stato fatto, finché non si preme "Ho letto". */
function NovitaBanner() {
  const [n, setN] = useState<NovitaInstallate | null>(null)
  useEffect(() => {
    void window.radio.novitaInstallate().then(setN)
  }, [])
  if (!n) return null
  return (
    <div className="banner ok novita-banner">
      <div className="row">
        <b>Radio Regia aggiornata alla versione {n.a}. Ecco cosa è cambiato:</b>
        <button
          className="small"
          onClick={() => {
            setN(null)
            void window.radio.novitaLette()
          }}
        >
          Ho letto
        </button>
      </div>
      {n.novita.length ? <ElencoNovita novita={n.novita} /> : <p>Nessuna descrizione per questa versione.</p>}
    </div>
  )
}

/** Versione nuova disponibile: si installa solo premendo "Aggiorna" (la regia si chiude e riparte). */
function UpdateBanner() {
  const [st, setSt] = useState<AggiornamentoStato | null>(null)
  const [nascosto, setNascosto] = useState<string | null>(null)
  const [conferma, setConferma] = useState(false)
  const [cosa, setCosa] = useState(false)
  useEffect(() => {
    void window.radio.aggiornamentoStato().then(setSt)
    return window.radio.onAggiornamento(setSt)
  }, [])
  if (!st || st.stato === 'nessuno' || (st.stato !== 'scarico' && nascosto === st.versione)) return null
  if (st.stato === 'scarico') return <div className="banner ok inline-banner">Scarico la versione nuova… {st.percentuale ?? 0}%</div>
  if (st.stato === 'errore')
    return (
      <div className="banner error inline-banner">
        Aggiornamento non riuscito: {st.errore}{' '}
        <button className="small" onClick={() => void window.radio.aggiornamentoInstalla().catch(() => undefined)}>
          Riprova
        </button>
      </div>
    )
  return (
    <>
      <div className="banner ok inline-banner">
        È disponibile Radio Regia {st.versione} (ora hai la {st.attuale}).{' '}
        {!!st.novita?.length && (
          <button className="small" onClick={() => setCosa(!cosa)}>
            {cosa ? 'Nascondi le novità' : 'Cosa cambia?'}
          </button>
        )}{' '}
        {conferma ? (
          <>
            La regia si chiude e riparte da sola (circa un minuto): se sei in onda, intanto il server manda la musica di emergenza.{' '}
            <button className="small" onClick={() => void window.radio.aggiornamentoInstalla().catch(() => undefined)}>
              Aggiorna adesso
            </button>{' '}
            <button className="small" onClick={() => setConferma(false)}>
              Annulla
            </button>
          </>
        ) : (
          <>
            <button className="small" onClick={() => setConferma(true)}>
              Aggiorna
            </button>{' '}
            <button className="small" onClick={() => setNascosto(st.versione ?? null)}>
              Più tardi
            </button>
          </>
        )}
      </div>
      {cosa && !!st.novita?.length && (
        <div className="banner ok novita-banner">
          <ElencoNovita novita={st.novita} />
        </div>
      )}
    </>
  )
}

function RestoredBanner() {
  const [from, setFrom] = useState<string | null>(null)
  const [off, setOff] = useState<string[]>([])
  useEffect(() => {
    void window.radio.restoredFrom().then(setFrom)
    void window.radio.restoredEventsOff().then(setOff)
  }, [])
  if (!from) return null
  return (
    <div className="banner warn inline-banner">
      Backup ripristinato. Il database precedente è stato conservato in: {from}
      {off.length > 0 && (
        <>
          {' '}
          Per sicurezza sono stati spenti gli eventi con un comando esterno: {off.join(', ')}. Controllali e riaccendili dalla scheda Eventi.
        </>
      )}
      <button className="small" onClick={() => setFrom(null)}>
        Chiudi
      </button>
    </div>
  )
}
