import { useEffect, useState } from 'react'
import { ConnectionView, uplinkClass } from './ConnectionView'
import { EventsView } from './EventsView'
import { hhmmss } from './format'
import { LibraryView } from './LibraryView'
import { LogView } from './LogView'
import { OnAirView } from './OnAirView'
import { SettingsView } from './SettingsView'
import { useRadio } from './useRadio'

type Tab = 'onair' | 'library' | 'events' | 'log' | 'link' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'onair', label: 'In onda' },
  { id: 'library', label: 'Libreria' },
  { id: 'events', label: 'Eventi' },
  { id: 'log', label: 'Registro' },
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
        {tab === 'onair' && <OnAirView radio={radio} />}
        {tab === 'library' && <LibraryView radio={radio} />}
        {tab === 'events' && <EventsView radio={radio} />}
        {tab === 'log' && <LogView />}
        {tab === 'link' && <ConnectionView radio={radio} />}
        {tab === 'settings' && <SettingsView radio={radio} />}
      </main>
    </div>
  )
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
