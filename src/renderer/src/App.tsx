import { PreviewContext } from './VoiceSection'
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { ConnectionView } from './ConnectionView'
import { EventsView } from './EventsView'
import { ProgramsView } from './ProgramsView'
import { GuideView } from './GuideView'
import { hhmmss } from './format'
import { LibraryView } from './LibraryView'
import { LogView } from './LogView'
import { OnAirView } from './OnAirView'
import { SettingsView } from './SettingsView'
import { StatsView } from './StatsView'
import { useRadio, type Radio } from './useRadio'
import { ConfermaProvider, useConferma } from './Conferma'
import { Benvenuto } from './Benvenuto'
import { AvvisoMuta } from './AvvisoMuta'
import { RiordinaContext, useOrdineSalvato } from './Riquadri'
import { salvaOrdine, spostaSezione, unisciOrdine } from './ordine'
import type { AggiornamentoStato, NovitaInstallate, NovitaVersione } from '../../shared/api'

type Tab = 'onair' | 'library' | 'events' | 'programs' | 'log' | 'stats' | 'link' | 'settings' | 'guide'

/** avanzata = si vede solo con "Mostra le cose avanzate" acceso in Impostazioni (regia a prova di anziano). */
const TABS: { id: Tab; label: string; avanzata?: boolean }[] = [
  { id: 'onair', label: 'In onda' },
  { id: 'library', label: 'Libreria' },
  { id: 'events', label: 'Eventi' },
  { id: 'programs', label: 'Programmi' },
  { id: 'log', label: 'Registro', avanzata: true },
  { id: 'stats', label: 'Ascoltatori' },
  { id: 'link', label: 'Collegamento', avanzata: true },
  { id: 'settings', label: 'Impostazioni' },
  { id: 'guide', label: 'Guida' }
]

/** Stato del collegamento in una frase, per la barra in alto. */
function fraseCollegamento(radio: Radio): { testo: string; classe: string; spiega: string } {
  const st = radio.ponte?.uplink.state
  if (st === 'collegato')
    return { testo: '✓ Gli ascoltatori ti sentono', classe: 'ok', spiega: 'La regia è collegata al server della radio.' }
  if (st === 'connessione' || st === 'riconnessione')
    return {
      testo: '… Mi collego al server',
      classe: 'warn',
      spiega: 'La regia si sta collegando da sola. Intanto gli ascoltatori sentono la musica di riserva del server.'
    }
  return {
    testo: '✗ Non arrivi agli ascoltatori',
    classe: 'bad',
    spiega: 'La regia non è collegata al server: gli ascoltatori sentono la musica di riserva. Riprova da sola; se dura, controlla internet.'
  }
}

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 250)
    return () => clearInterval(t)
  }, [])
  return <div className="clock">{hhmmss(now)}</div>
}

export function App() {
  return (
    <ConfermaProvider>
      <Regia />
    </ConfermaProvider>
  )
}

function Regia() {
  const radio = useRadio()
  const conferma = useConferma()
  const [tab, setTab] = useState<Tab>('onair')
  const avanzate = radio.settings.mostraAvanzate
  useEffect(() => window.radio.setZoom(radio.settings.testoGrande ? 1.25 : 1), [radio.settings.testoGrande])
  const [riordina, setRiordina] = useState(false)
  const ordineSchede = unisciOrdine(
    TABS.map((t) => t.id),
    useOrdineSalvato('schede')
  )
  // una scheda avanzata aperta da un avviso (es. "2 avvisi" → Collegamento) resta visibile finché è aperta
  const schede = ordineSchede
    .map((id) => TABS.find((t) => t.id === id))
    .filter((t) => !!t)
    .filter((t) => avanzate || !t.avanzata || t.id === tab)
  const spostaScheda = (id: Tab, verso: -1 | 1) =>
    salvaOrdine('schede', spostaSezione(ordineSchede, TABS.map((t) => t.id), id, verso))
  const auto = radio.snapshot.mode === 'auto'
  const onAir = radio.snapshot.onAir.length > 0
  const link = fraseCollegamento(radio)
  const cambiaModo = async (): Promise<void> => {
    if (auto) {
      const ok = await conferma({
        titolo: 'Passare a MANUALE?',
        testo:
          'In MANUALE la regia non sceglie più i brani da sola: sei tu a metterli in coda. Quando la coda finisce, la musica si ferma.',
        si: 'Sì, passa a MANUALE',
        no: 'No, resta in AUTOMATICO'
      })
      if (!ok) return
    }
    radio.engine.setMode(auto ? 'manual' : 'auto')
  }

  return (
    <PreviewContext.Provider value={radio.preview}>
    <RiordinaContext.Provider value={riordina}>
    <div className="app">
      <header className="topbar">
        <div className={`onair-lamp ${onAir ? 'lit' : ''}`}>{onAir ? 'IN ONDA' : 'FERMO'}</div>
        <nav className={`tabs ${riordina ? 'riordina-attivo' : ''}`}>
          {schede.map((t, i) =>
            riordina ? (
              <span key={t.id} className="riordina-voce scheda">
                <button className="small" disabled={i === 0} title="Sposta a sinistra" onClick={() => spostaScheda(t.id, -1)}>
                  ◀
                </button>
                <button className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
                <button
                  className="small"
                  disabled={i === schede.length - 1}
                  title="Sposta a destra"
                  onClick={() => spostaScheda(t.id, 1)}
                >
                  ▶
                </button>
              </span>
            ) : (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            )
          )}
        </nav>
        {(avanzate || riordina) && <button
          className={`riordina-btn ${riordina ? 'active' : ''}`}
          onClick={() => setRiordina(!riordina)}
          title="Cambia l'ordine delle schede in alto e dei riquadri di ogni pagina"
        >
          {riordina ? '✓ Fatto' : '⇅ Riordina'}
        </button>}
        {riordina && ordineSchede.join() !== TABS.map((t) => t.id).join() && (
          <button className="small" onClick={() => salvaOrdine('schede', null)} title="Torna all'ordine originale delle schede">
            Ripristina schede
          </button>
        )}
        {radio.settings.ponte.enabled && (
          <button className={`link-pill ${link.classe}`} onClick={() => setTab('link')} title={link.spiega}>
            {link.testo}
          </button>
        )}
        {!radio.settings.ponte.enabled && (
          <button
            className="link-pill off"
            onClick={() => setTab('link')}
            title="La regia suona solo qui in studio. Per collegarla al server serve il codice di collegamento."
          >
            Non collegata al server
          </button>
        )}
        {radio.settings.ponte.enabled && !!radio.ponte?.alarms.length && (
          <button className="link-pill bad" onClick={() => setTab('link')} title="Apri per leggere cosa succede">
            ⚠ {radio.ponte.alarms.length === 1 ? '1 avviso' : `${radio.ponte.alarms.length} avvisi`}
          </button>
        )}
        <button
          className={`mode ${auto ? 'auto' : 'manual'}`}
          onClick={() => void cambiaModo()}
          title={auto ? 'La regia sceglie e manda in onda i brani da sola. Premi per passare a MANUALE.' : 'Sei tu a scegliere i brani. Premi per passare ad AUTOMATICO: la regia sceglie da sola.'}
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
      <AvvisoMuta radio={radio} />
      <Benvenuto radio={radio} />
      <main>
        {/* sotto useRadio: un errore in una scheda non smonta App e non ferma la messa in onda */}
        <ViewErrorBoundary key={tab}>
          {tab === 'onair' && <OnAirView radio={radio} />}
          {tab === 'library' && <LibraryView radio={radio} />}
          {tab === 'events' && <EventsView radio={radio} />}
          {tab === 'programs' && <ProgramsView />}
          {tab === 'log' && <LogView />}
          {tab === 'stats' && <StatsView />}
          {tab === 'link' && <ConnectionView radio={radio} />}
          {tab === 'settings' && <SettingsView radio={radio} />}
          {tab === 'guide' && <GuideView />}
        </ViewErrorBoundary>
      </main>
    </div>
    </RiordinaContext.Provider>
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
