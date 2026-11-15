import { PreviewContext } from './VoiceSection'
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { ConnectionView, uplinkClass } from './ConnectionView'
import { EventsView } from './EventsView'
import { hhmmss } from './format'
import { LibraryView } from './LibraryView'
import { LogView } from './LogView'
import { OnAirView } from './OnAirView'
import { SettingsView } from './SettingsView'
import { StatsView } from './StatsView'
import { useRadio } from './useRadio'

type Tab = 'onair' | 'library' | 'events' | 'log' | 'stats' | 'link' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'onair', label: 'In onda' },
  { id: 'library', label: 'Libreria' },
  { id: 'events', label: 'Eventi' },
  { id: 'log', label: 'Registro' },
  { id: 'stats', label: 'Ascoltatori' },
  { id: 'link', label: 'Collegamento' },
  { id: 'settings', label: 'Impostazioni' }
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

function RestoredBanner() {
  const [from, setFrom] = useState<string | null>(null)
  useEffect(() => {
    void window.radio.restoredFrom().then(setFrom)
  }, [])
  if (!from) return null
  return (
    <div className="banner warn inline-banner">
      Backup ripristinato. Il database precedente è stato conservato in: {from}
      <button className="small" onClick={() => setFrom(null)}>
        Chiudi
      </button>
    </div>
  )
}
