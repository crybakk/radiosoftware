import { ALL_MIX_STYLES, MIX_STYLES } from '../../core/djMix'
import { useEffect, useState } from 'react'
import type { Settings, Track } from '../../core/types'
import type { NewsSource } from '../../core/news'
import type { AggiornamentoStato } from '../../shared/api'
import { listOutputDevices } from './audio'
import { mmss } from './format'
import { VoiceSection } from './VoiceSection'
import type { Radio } from './useRadio'
import { Riquadri } from './Riquadri'
import { scegliUscite } from './sceltaSchede'

const NUMBERS: { key: keyof Settings; label: string; hint: string; min: number; max: number; step?: number }[] = [
  { key: 'crossfadeSeconds', label: 'Dissolvenza (secondi)', hint: 'Usata quando premi AVANTI', min: 0, max: 15, step: 0.5 },
  { key: 'targetLoudness', label: 'Volume obiettivo (LUFS)', hint: 'Tutti i brani vengono livellati a questo valore. -16 è uno standard comune per lo streaming', min: -24, max: -9 },
  { key: 'artistSeparationMinutes', label: 'Separazione artista (minuti)', hint: 'Tempo minimo prima di ripetere lo stesso artista', min: 0, max: 600 },
  { key: 'titleSeparationMinutes', label: 'Separazione brano (minuti)', hint: 'Tempo minimo prima di ripetere lo stesso brano', min: 0, max: 2880 },
  { key: 'jingleEvery', label: 'Un jingle ogni … brani', hint: '0 = nessun jingle automatico', min: 0, max: 20 },
  { key: 'autoQueueLength', label: 'Brani in coda in automatico', hint: 'Quanti brani preparare in anticipo', min: 2, max: 20 }
]

/** Scelte semplici al posto dei numeri (regia a prova di anziano). Un valore fuori elenco si mostra com'è. */
const SCELTE: { key: keyof Settings; label: string; opzioni: [number, string][]; unita: string }[] = [
  {
    key: 'artistSeparationMinutes',
    label: 'Quanto spesso può tornare lo stesso cantante',
    opzioni: [[30, 'Spesso (dopo mezz\'ora)'], [60, 'Normale (dopo un\'ora)'], [120, 'Di rado (dopo due ore)']],
    unita: 'minuti'
  },
  {
    key: 'titleSeparationMinutes',
    label: 'Quanto spesso può tornare la stessa canzone',
    opzioni: [[90, 'Spesso (dopo un\'ora e mezza)'], [180, 'Normale (dopo tre ore)'], [360, 'Di rado (dopo sei ore)']],
    unita: 'minuti'
  },
  {
    key: 'jingleEvery',
    label: 'Jingle tra le canzoni',
    opzioni: [[0, 'Mai'], [2, 'Ogni 2 canzoni'], [3, 'Ogni 3 canzoni'], [4, 'Ogni 4 canzoni'], [6, 'Ogni 6 canzoni']],
    unita: 'canzoni'
  },
  {
    key: 'crossfadeSeconds',
    label: 'Sfumatura quando premi AVANTI',
    opzioni: [[1.5, 'Breve'], [3, 'Normale'], [6, 'Lunga']],
    unita: 'secondi'
  }
]

function SceltaSemplice({ c, value, onChange }: { c: (typeof SCELTE)[number]; value: number; onChange: (v: number) => void }) {
  const fuori = Number.isFinite(value) && !c.opzioni.some(([v]) => v === value)
  return (
    <label>
      <span>{c.label}</span>
      <select value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
        {c.opzioni.map(([v, l]) => (
          <option key={v} value={String(v)}>
            {l}
          </option>
        ))}
        {fuori && <option value={String(value)}>Scelta tua: {value} {c.unita}</option>}
      </select>
    </label>
  )
}

const FALLBACKS: { value: NewsSource['ifMissing']; label: string }[] = [
  { value: 'salta', label: 'Saltalo' },
  { value: 'vecchio', label: "Manda l'ultimo scaricato" },
  { value: 'file', label: 'Manda un file a scelta' },
  { value: 'voce', label: 'Leggi un testo con la voce sintetica' }
]

/** Problema in una fonte dei notiziari (null = va bene). */
function newsProblem(n: NewsSource): string | null {
  if (!n.name.trim()) return 'manca il nome di una fonte'
  if (!/^https?:\/\/\S+$/i.test(n.url.trim())) return `il link di "${n.name}" deve cominciare con http:// o https://`
  if (n.ifMissing === 'file' && !n.fallbackFile) return `scegli il file da mandare quando manca "${n.name}"`
  if (n.ifMissing === 'voce' && !n.fallbackText?.trim()) return `scrivi il testo da leggere quando manca "${n.name}"`
  return null
}

/** Una fonte dei notiziari, con la prova (scarica e ascolta in preascolto). */
function NewsRow({ n, onChange, onRemove, radio }: { n: NewsSource; onChange: (n: NewsSource) => void; onRemove: () => void; radio: Radio }) {
  const [test, setTest] = useState<{ busy: boolean; note: string; track: Track | null } | null>(null)
  const listening = test?.track && radio.preview.trackId === test.track.id
  return (
    <li className="news-source">
      <div className="form-grid three">
        <label>
          <span>Nome</span>
          <input value={n.name} placeholder="es. GR nazionale" onChange={(e) => onChange({ ...n, name: e.target.value })} />
        </label>
        <label className="span2">
          <span>Link del feed del podcast o del file audio</span>
          <input value={n.url} placeholder="https://…/feed.xml oppure https://…/ultimo.mp3" onChange={(e) => onChange({ ...n, url: e.target.value.trim() })} />
        </label>
        <label>
          <span>
            Età massima (minuti) <em>· 0 = nessun limite</em>
          </span>
          <input type="number" min={0} max={10080} value={n.maxAgeMinutes} onChange={(e) => onChange({ ...n, maxAgeMinutes: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <label>
          <span>Se è vecchio o non si scarica</span>
          <select value={n.ifMissing} onChange={(e) => onChange({ ...n, ifMissing: e.target.value as NewsSource['ifMissing'] })}>
            {FALLBACKS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {n.ifMissing === 'voce' && (
          <label className="span2">
            <span>Testo da leggere al suo posto</span>
            <input
              value={n.fallbackText ?? ''}
              placeholder="es. Sono le {ora}: il notiziario oggi non è disponibile."
              onChange={(e) => onChange({ ...n, fallbackText: e.target.value })}
            />
          </label>
        )}
        {n.ifMissing === 'file' && (
          <label>
            <span>File da mandare</span>
            <div className="row">
              <input readOnly value={n.fallbackFile} placeholder="nessun file" />
              <button
                className="small"
                onClick={async () => {
                  const p = await window.radio.choosePath('audio')
                  if (p) onChange({ ...n, fallbackFile: p })
                }}
              >
                Scegli…
              </button>
            </div>
          </label>
        )}
      </div>
      <div className="row">
        <button
          className="small"
          disabled={!!test?.busy || !!newsProblem(n)}
          onClick={async () => {
            setTest({ busy: true, note: 'Scarico…', track: null })
            try {
              setTest({ busy: false, ...(await window.radio.newsTest(n)) })
            } catch (e) {
              setTest({ busy: false, note: e instanceof Error ? e.message : String(e), track: null })
            }
          }}
        >
          Prova
        </button>
        {test?.track && (
          <button
            className="small"
            onClick={() => {
              if (listening) radio.preview.stop()
              else void radio.preview.play(window.radio.mediaUrl(test.track!), test.track!.id)
              setTest({ ...test })
            }}
          >
            {listening ? '■ Ferma' : '🎧 Ascolta in preascolto'}
          </button>
        )}
        <button className="small danger" onClick={onRemove}>
          Togli
        </button>
        {test && (
          <span className="hint">
            {test.note}
            {test.track ? ` · durata ${mmss(test.track.duration)}` : ''}
          </span>
        )}
      </div>
    </li>
  )
}

/** Versione installata e controllo degli aggiornamenti a richiesta (si installa solo dalla barra in alto). */
function UpdateSection() {
  const [st, setSt] = useState<AggiornamentoStato | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.radio.aggiornamentoStato().then(setSt)
    return window.radio.onAggiornamento(setSt)
  }, [])
  const quando = st?.controllato ? new Date(st.controllato).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
  let esito = ''
  if (st?.controllo === 'non installato') esito = 'Avviata dal codice: gli aggiornamenti funzionano solo nel programma installato.'
  else if (st?.controllo?.startsWith('non riuscito')) esito = `Controllo ${st.controllo}`
  else if (st?.stato === 'disponibile' || st?.stato === 'pronto') esito = `È disponibile la versione ${st.versione}: premi "Aggiorna" nella barra in alto.`
  else if (st?.soloServer) esito = `La versione ${st.soloServer} cambia solo il server: la regia non ha bisogno di aggiornarsi.`
  else if (st?.controllo === 'ok') esito = 'È l\'ultima versione.'
  return (
    <section className="panel" data-sezione="aggiornamenti" data-titolo="Aggiornamenti">
      <div className="section-title">Aggiornamenti</div>
      <p className="hint">
        Versione installata: <b>{st?.attuale ?? '…'}</b>. La regia controlla da sola all'avvio e ogni 6 ore, ma non si
        aggiorna mai senza che tu lo chieda.
      </p>
      <div className="row">
        <button
          disabled={busy || st?.controllo === 'in corso'}
          onClick={async () => {
            setBusy(true)
            try {
              setSt(await window.radio.aggiornamentoControlla())
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy || st?.controllo === 'in corso' ? 'Controllo…' : 'Controlla aggiornamenti'}
        </button>
        {esito && <span className="hint">{esito}</span>}
        {quando && <span className="hint">Ultimo controllo: {quando}</span>}
      </div>
    </section>
  )
}

export function SettingsView({ radio }: { radio: Radio }) {
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([])
  const [draft, setDraft] = useState<Settings>(radio.settings)
  const [saved, setSaved] = useState(false)
  const newsError = draft.news.map(newsProblem).find(Boolean) ?? null
  const setNews = (i: number, n: NewsSource | null): void =>
    setDraft({ ...draft, news: n ? draft.news.map((x, j) => (j === i ? n : x)) : draft.news.filter((_, j) => j !== i) })

  useEffect(() => setDraft(radio.settings), [radio.settings])
  useEffect(() => {
    void listOutputDevices().then(setDevices)
  }, [])

  const dirty = JSON.stringify(draft) !== JSON.stringify(radio.settings)
  const avanzate = radio.settings.mostraAvanzate

  return (
    <Riquadri className="settings-view" chiave="impostazioni" nome="Impostazioni">
      <section className="panel" data-sezione="aspetto" data-titolo="Come si vede">
        <div className="section-title">Come si vede</div>
        <label className="check grande">
          <input
            type="checkbox"
            checked={radio.settings.testoGrande}
            onChange={(e) => void radio.saveSettings({ testoGrande: e.target.checked })}
          />
          <span>Testo grande (scritte e pulsanti più grandi, per vedere meglio)</span>
        </label>
      </section>
      <UpdateSection />
      <section className="panel" data-sezione="schede-audio" data-titolo="Schede audio">
        <div className="section-title">Schede audio</div>
        <p className="hint">
          La musica in onda esce dal RodeCaster; il preascolto (quello che senti prima di mandarlo in onda) da un'uscita
          diversa, per esempio le casse o le cuffie del computer. Se non sai cosa scegliere premi "Scegli da sola".
        </p>
        <div className="form-grid">
          <label>
            <span>Musica in onda</span>
            <select value={draft.outputDeviceId} onChange={(e) => setDraft({ ...draft, outputDeviceId: e.target.value })}>
              {devices.map((d) => (
                <option key={d.deviceId || 'default'} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Preascolto in cuffia</span>
            <select value={draft.previewDeviceId} onChange={(e) => setDraft({ ...draft, previewDeviceId: e.target.value })}>
              {devices.map((d) => (
                <option key={d.deviceId || 'default'} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <button
            className="small"
            onClick={async () => {
              const d = await listOutputDevices()
              setDevices(d)
              const sc = scegliUscite(d)
              setDraft({ ...draft, outputDeviceId: sc.onda, previewDeviceId: sc.preascolto })
            }}
          >
            Scegli da sola
          </button>
          <button className="small" onClick={() => void listOutputDevices().then(setDevices)}>
            Cerca di nuovo le schede
          </button>
        </div>
      </section>

      <section className="panel" data-sezione="musica" data-titolo="Musica">
        <div className="section-title">Musica</div>
        <div className="form-grid">
          {SCELTE.map((c) => (
            <SceltaSemplice key={c.key} c={c} value={draft[c.key] as number} onChange={(v) => setDraft({ ...draft, [c.key]: v })} />
          ))}
          <label className="check grande">
            <input type="checkbox" checked={draft.djMix} onChange={(e) => setDraft({ ...draft, djMix: e.target.checked })} />
            <span>Passaggi da DJ tra una canzone e l'altra (a tempo di musica)</span>
          </label>
        </div>
      </section>

      {avanzate && <section className="panel" data-sezione="messa-in-onda" data-titolo="Musica: regolazioni precise">
        <div className="section-title">Musica: regolazioni precise</div>
        <div className="form-grid">
          {NUMBERS.map((n) => (
            <label key={n.key}>
              <span>
                {n.label} <em>· {n.hint}</em>
              </span>
              <input
                type="number"
                min={n.min}
                max={n.max}
                step={n.step ?? 1}
                value={Number.isFinite(draft[n.key]) ? (draft[n.key] as number) : ''}
                // campo vuoto (o "-" a metà digitazione): NaN, al salvataggio resta il valore precedente
                onChange={(e) =>
                  setDraft({ ...draft, [n.key]: e.target.value.trim() === '' ? NaN : Number(e.target.value) })
                }
              />
            </label>
          ))}
          <label>
            <span>
              Mix DJ: velocità massima cambiata <em>· quanto può accelerare o rallentare il brano che entra</em>
            </span>
            <select
              value={Math.round(draft.djMaxStretch * 100)}
              onChange={(e) => setDraft({ ...draft, djMaxStretch: Number(e.target.value) / 100 })}
            >
              {[3, 4, 6, 8, 10].map((p) => (
                <option key={p} value={p}>
                  ±{p}%{p === 6 ? ' (consigliato)' : p > 6 ? ' (si sente di più)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="dj-styles">
            <span>
              Mix DJ: passaggi che la regia può usare <em>· sceglie lei il più adatto; quelli con ★ solo ogni tanto</em>
            </span>
            {MIX_STYLES.map((m) => (
              <label key={m.id} className="check" title={m.help}>
                <input
                  type="checkbox"
                  checked={draft.djStyles.includes(m.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      djStyles: e.target.checked
                        ? ALL_MIX_STYLES.filter((id) => id === m.id || draft.djStyles.includes(id))
                        : draft.djStyles.filter((id) => id !== m.id)
                    })
                  }
                />
                <span>
                  {m.label}
                  {m.showy ? ' ★' : ''} <em>· {m.help}</em>
                </span>
              </label>
            ))}
          </div>
        </div>
      </section>}

      {avanzate && <section className="panel" data-sezione="notiziari" data-titolo="Notiziari">
        <div className="section-title">Notiziari</div>
        <p className="hint">
          Fonti dei notiziari da mandare in onda con gli eventi (azione "Notiziario"). Metti il link del feed di un
          podcast (si prende l'ultima puntata) oppure il link diretto a un file audio. Il notiziario si scarica solo
          all'ora dell'evento, e solo se è cambiato dall'ultima volta. Prima di ritrasmettere notiziari di altri,
          assicurati di avere il permesso.
        </p>
        <ul className="news-sources">
          {draft.news.map((n, i) => (
            <NewsRow key={n.id} n={n} radio={radio} onChange={(x) => setNews(i, x)} onRemove={() => setNews(i, null)} />
          ))}
          {!draft.news.length && <li className="empty">Nessuna fonte.</li>}
        </ul>
        <button
          className="small"
          onClick={() =>
            setDraft({
              ...draft,
              news: [...draft.news, { id: `n${Date.now().toString(36)}`, name: '', url: '', maxAgeMinutes: 90, ifMissing: 'salta', fallbackFile: '' }]
            })
          }
        >
          Aggiungi fonte
        </button>
      </section>}

      {avanzate && <VoiceSection draft={draft} setDraft={setDraft} />}

      {avanzate && <section className="panel" data-sezione="servizi-dati" data-titolo="Servizi per i dati dei brani">
        <div className="section-title">Servizi per i dati dei brani</div>
        <p className="hint">
          Oltre a MusicBrainz, la regia può chiedere generi e caratteristiche dei brani ad altri servizi gratuiti. Ognuno
          vuole una chiave personale: creala dal link, incollala qui e premi Salva. Poi avvia la ricerca dalla Libreria.
        </p>
        <div className="form-grid">
          <label>
            <span>
              Contatto per MusicBrainz <em>· email o sito</em>
            </span>
            <input
              type="text"
              autoComplete="off"
              value={draft.mbContact}
              placeholder="per esempio la tua email"
              onChange={(e) => setDraft({ ...draft, mbContact: e.target.value })}
            />
            <small className="hint">MusicBrainz chiede un contatto a chi usa il servizio: viene mandato solo a MusicBrainz.</small>
          </label>
          {(
            [
              ['discogsToken', 'Token di Discogs', 'Generi e stili', 'https://www.discogs.com/settings/developers', 'Discogs → Impostazioni → Developers → Generate new token'],
              ['lastfmKey', 'Chiave API di Last.fm', 'Etichette: carattere, decennio', 'https://www.last.fm/api/account/create', 'Last.fm → crea un account API, copia la "API key"'],
              ['acoustidKey', 'Chiave applicazione di AcoustID', 'Trova i brani dall\'audio', 'https://acoustid.org/new-application', 'AcoustID → accedi → New application, copia la "API key"']
            ] as const
          ).map(([key, label, what, url, how]) => (
            <label key={key}>
              <span>
                {label} <em>· {what}</em>
              </span>
              <input
                type="password"
                autoComplete="off"
                value={draft[key]}
                placeholder="incolla qui la chiave"
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value.trim() })}
              />
              <small className="hint">
                {how}:{' '}
                <a href={url} target="_blank" rel="noreferrer">
                  {url.replace('https://', '')}
                </a>
              </small>
            </label>
          ))}
        </div>
      </section>}

      <section className="panel avanzate" data-sezione="avanzate" data-titolo="Cose avanzate">
        <div className="section-title">Cose avanzate</div>
        <p className="hint">
          Per chi conosce la parte tecnica: mostra le schede Registro e Collegamento, il pulsante Riordina e le impostazioni
          tecniche. Chi usa la regia tutti i giorni può lasciarle nascoste: non servono per andare in onda.
        </p>
        <label className="check grande">
          <input
            type="checkbox"
            checked={radio.settings.mostraAvanzate}
            onChange={(e) => void radio.saveSettings({ mostraAvanzate: e.target.checked })}
          />
          <span>Mostra le cose avanzate</span>
        </label>
      </section>

      <section className="panel avanzate" data-sezione="avanzate" data-titolo="Cose avanzate">
        <div className="section-title">Cose avanzate</div>
        <p className="hint">
          Per chi conosce la parte tecnica: mostra le schede Registro e Collegamento, il pulsante Riordina e le impostazioni
          tecniche. Chi usa la regia tutti i giorni può lasciarle nascoste: non servono per andare in onda.
        </p>
        <label className="check grande">
          <input
            type="checkbox"
            checked={radio.settings.mostraAvanzate}
            onChange={(e) => void radio.saveSettings({ mostraAvanzate: e.target.checked })}
          />
          <span>Mostra le cose avanzate</span>
        </label>
      </section>

      <div className="row end sticky">
        {newsError && dirty && <span className="hint error-text">Notiziari: {newsError}</span>}
        {saved && !dirty && <span className="hint">Impostazioni salvate</span>}
        <button disabled={!dirty} onClick={() => setDraft(radio.settings)}>
          Annulla modifiche
        </button>
        <button
          className="primary"
          disabled={!dirty || !!newsError}
          onClick={async () => {
            const clamp = { ...draft }
            for (const n of NUMBERS) {
              // campo lasciato vuoto o non valido: si tiene il valore salvato, non 0 o il minimo
              const v = Number.isFinite(clamp[n.key]) ? Number(clamp[n.key]) : Number(radio.settings[n.key])
              ;(clamp as unknown as Record<string, number>)[n.key] = Math.min(n.max, Math.max(n.min, Number.isFinite(v) ? v : n.min))
            }
            await radio.saveSettings(clamp)
            setSaved(true)
          }}
        >
          Salva
        </button>
      </div>
    </Riquadri>
  )
}
