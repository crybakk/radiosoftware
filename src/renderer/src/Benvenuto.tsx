// Prima accensione guidata (regia a prova di anziano, 26/11/2026): tre passi e la regia è pronta.
// 1) cartella della musica  2) schede audio (il RodeCaster viene scelto da solo)  3) codice di collegamento.
// Ogni passo si può saltare; chi ha già una regia configurata non la vede.
import { useEffect, useState } from 'react'
import { leggiCodice } from '../../../ponte/controllo/src/codiceCollegamento.ts'
import type { LibraryFolder, Settings } from '../../core/types'
import { listOutputDevices } from './audio'
import { scegliUscite, type Uscita } from './sceltaSchede'
import type { Radio } from './useRadio'

const api = window.radio

/** Applica un codice di collegamento incollato: null se è andato bene, altrimenti cosa non va. */
export async function collegaConCodice(radio: Radio, testo: string): Promise<string | null> {
  const r = leggiCodice(testo)
  if (!r.ok) return r.errore
  await radio.saveSettings({
    ponte: {
      ...radio.settings.ponte,
      host: r.host,
      controlPort: r.controlPort,
      controlHttps: r.controlHttps,
      srtPort: r.srtPort,
      passphrase: r.passphrase,
      controlToken: r.controlToken,
      enabled: true
    }
  })
  return null
}

type Passo = 'musica' | 'audio' | 'collega' | 'fatto'

export function Benvenuto({ radio }: { radio: Radio }) {
  const [aperto, setAperto] = useState(false)
  const [passo, setPasso] = useState<Passo>('musica')
  const [cartelle, setCartelle] = useState<LibraryFolder[]>([])

  useEffect(() => {
    void Promise.all([api.getSettings(), api.listFolders()]).then(([s, f]: [Settings, LibraryFolder[]]) => {
      setCartelle(f)
      if (s.benvenutoFatto) return
      // regia già configurata prima di questa versione: niente benvenuto
      if (f.length > 0 && s.ponte.host) {
        void api.saveSettings({ benvenutoFatto: true })
        return
      }
      setAperto(true)
    })
  }, [])

  if (!aperto) return null
  const chiudi = (): void => {
    setAperto(false)
    void radio.saveSettings({ benvenutoFatto: true })
  }
  const numero = { musica: 1, audio: 2, collega: 3, fatto: 3 }[passo]

  return (
    <div className="modal benvenuto">
      <div className="modal-body benvenuto-body">
        <div className="benvenuto-testa">
          <span className="benvenuto-titolo">Benvenuto in Radio Regia</span>
          {passo !== 'fatto' && <span className="benvenuto-passo">Passo {numero} di 3</span>}
        </div>
        {passo === 'musica' && <PassoMusica cartelle={cartelle} setCartelle={setCartelle} avanti={() => setPasso('audio')} />}
        {passo === 'audio' && <PassoAudio radio={radio} avanti={() => setPasso('collega')} />}
        {passo === 'collega' && <PassoCollega radio={radio} avanti={() => setPasso('fatto')} />}
        {passo === 'fatto' && (
          <>
            <p className="benvenuto-testo">
              <b>Tutto pronto!</b> Premi il pulsante arancione <b>MANUALE</b> in alto a destra: diventa <b>AUTOMATICO</b> e la
              regia comincia a suonare da sola.
            </p>
            <p className="benvenuto-testo">Se hai dubbi, apri la scheda <b>Guida</b> in alto.</p>
            <div className="benvenuto-pulsanti">
              <button className="primary big-ish" onClick={chiudi}>
                Inizia
              </button>
            </div>
          </>
        )}
        {passo !== 'fatto' && (
          <button className="link benvenuto-salta" onClick={chiudi}>
            Salta, lo faccio dopo
          </button>
        )}
      </div>
    </div>
  )
}

function PassoMusica({
  cartelle,
  setCartelle,
  avanti
}: {
  cartelle: LibraryFolder[]
  setCartelle: (f: LibraryFolder[]) => void
  avanti: () => void
}) {
  const musica = cartelle.filter((c) => c.kind === 'music')
  return (
    <>
      <p className="benvenuto-testo">Dove tieni la musica? Scegli la cartella che contiene le canzoni: la regia le legge tutte da sola.</p>
      {musica.map((c) => (
        <div key={c.id} className="benvenuto-ok">
          ✓ {c.path}
        </div>
      ))}
      <div className="benvenuto-pulsanti">
        <button
          className={musica.length ? 'big-ish' : 'primary big-ish'}
          onClick={async () => {
            const f = await api.chooseAndAddFolder('music')
            setCartelle(f)
            if (f.length) void api.scan()
          }}
        >
          {musica.length ? 'Aggiungi un\'altra cartella' : 'Scegli la cartella della musica'}
        </button>
        <button className={musica.length ? 'primary big-ish' : 'big-ish'} disabled={!musica.length} onClick={avanti}>
          Avanti
        </button>
      </div>
      {musica.length > 0 && <p className="hint">La regia sta leggendo i brani: puoi andare avanti intanto.</p>}
    </>
  )
}

function PassoAudio({ radio, avanti }: { radio: Radio; avanti: () => void }) {
  const [uscite, setUscite] = useState<Uscita[] | null>(null)
  const [onda, setOnda] = useState('')
  const [pre, setPre] = useState('')
  const [rode, setRode] = useState(false)
  const carica = async (): Promise<void> => {
    const u = await listOutputDevices()
    const scelta = scegliUscite(u)
    setUscite(u)
    setOnda(scelta.onda)
    setPre(scelta.preascolto)
    setRode(scelta.rodecaster)
  }
  useEffect(() => {
    void carica()
  }, [])
  const elenco = (v: string, set: (v: string) => void) => (
    <select value={v} onChange={(e) => set(e.target.value)}>
      {(uscite ?? []).map((d) => (
        <option key={d.deviceId || 'default'} value={d.deviceId}>
          {d.label}
        </option>
      ))}
    </select>
  )
  return (
    <>
      <p className="benvenuto-testo">
        {rode
          ? '✓ Ho trovato il RodeCaster: la musica in onda esce da lì. Il preascolto (quello che senti prima di mandarlo in onda) esce dalle casse o dalle cuffie del computer.'
          : 'Non vedo il RodeCaster. Se è spento o scollegato, accendilo, collegalo con il cavo USB e premi "Cerca di nuovo".'}
      </p>
      {uscite && (
        <div className="form-grid">
          <label>
            <span>Musica in onda</span>
            {elenco(onda, setOnda)}
          </label>
          <label>
            <span>Preascolto in cuffia</span>
            {elenco(pre, setPre)}
          </label>
        </div>
      )}
      <div className="benvenuto-pulsanti">
        <button className="big-ish" onClick={() => void carica()}>
          Cerca di nuovo
        </button>
        <button
          className="primary big-ish"
          onClick={async () => {
            await radio.saveSettings({ outputDeviceId: onda, previewDeviceId: pre })
            avanti()
          }}
        >
          Avanti
        </button>
      </div>
    </>
  )
}

function PassoCollega({ radio, avanti }: { radio: Radio; avanti: () => void }) {
  const [testo, setTesto] = useState('')
  const [errore, setErrore] = useState<string | null>(null)
  return (
    <>
      <p className="benvenuto-testo">
        Per far sentire la radio su internet, la regia si collega al server. Chiedi a chi gestisce il server il{' '}
        <b>codice di collegamento</b> (si trova nel pannello: Impostazioni server → Collega la regia) e incollalo qui sotto.
      </p>
      <textarea
        className="codice-collegamento"
        rows={3}
        spellCheck={false}
        placeholder="Incolla qui il codice (inizia con RADIO-REGIA1.)"
        value={testo}
        onChange={(e) => {
          setTesto(e.target.value)
          setErrore(null)
        }}
      />
      {errore && <div className="banner error inline-banner">{errore}</div>}
      <div className="benvenuto-pulsanti">
        <button className="big-ish" onClick={avanti}>
          Non ce l'ho, lo faccio dopo
        </button>
        <button
          className="primary big-ish"
          disabled={!testo.trim()}
          onClick={async () => {
            const e = await collegaConCodice(radio, testo)
            if (e) setErrore(e)
            else avanti()
          }}
        >
          Collega
        </button>
      </div>
    </>
  )
}
