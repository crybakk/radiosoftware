import { useEffect, useState } from 'react'
import type { Settings, Track } from '../../core/types'
import type { NewsSource } from '../../core/news'
import { listOutputDevices } from './audio'
import { mmss } from './format'
import type { Radio } from './useRadio'

const NUMBERS: { key: keyof Settings; label: string; hint: string; min: number; max: number; step?: number }[] = [
  { key: 'crossfadeSeconds', label: 'Dissolvenza (secondi)', hint: 'Usata quando premi AVANTI', min: 0, max: 15, step: 0.5 },
  { key: 'targetLoudness', label: 'Volume obiettivo (LUFS)', hint: 'Tutti i brani vengono livellati a questo valore. -16 è uno standard comune per lo streaming', min: -24, max: -9 },
  { key: 'artistSeparationMinutes', label: 'Separazione artista (minuti)', hint: 'Tempo minimo prima di ripetere lo stesso artista', min: 0, max: 600 },
  { key: 'titleSeparationMinutes', label: 'Separazione brano (minuti)', hint: 'Tempo minimo prima di ripetere lo stesso brano', min: 0, max: 2880 },
  { key: 'jingleEvery', label: 'Un jingle ogni … brani', hint: '0 = nessun jingle automatico', min: 0, max: 20 },
  { key: 'autoQueueLength', label: 'Brani in coda in automatico', hint: 'Quanti brani preparare in anticipo', min: 2, max: 20 }
]

const FALLBACKS: { value: NewsSource['ifMissing']; label: string }[] = [
  { value: 'salta', label: 'Saltalo' },
  { value: 'vecchio', label: "Manda l'ultimo scaricato" },
  { value: 'file', label: 'Manda un file a scelta' }
]

/** Problema in una fonte dei notiziari (null = va bene). */
function newsProblem(n: NewsSource): string | null {
  if (!n.name.trim()) return 'manca il nome di una fonte'
  if (!/^https?:\/\/\S+$/i.test(n.url.trim())) return `il link di "${n.name}" deve cominciare con http:// o https://`
  if (n.ifMissing === 'file' && !n.fallbackFile) return `scegli il file da mandare quando manca "${n.name}"`
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

  return (
    <div className="settings-view">
      <section className="panel">
        <div className="section-title">Schede audio</div>
        <p className="hint">
          Con il RodeCaster Duo collegato via USB, scegli come uscita "in onda" il canale del RodeCaster dedicato al
          computer, e come preascolto un'uscita diversa (per esempio il canale chat o le cuffie del PC).
        </p>
        <div className="form-grid">
          <label>
            <span>Uscita in onda</span>
            <select value={draft.outputDeviceId} onChange={(e) => setDraft({ ...draft, outputDeviceId: e.target.value })}>
              {devices.map((d) => (
                <option key={d.deviceId || 'default'} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Uscita preascolto</span>
            <select value={draft.previewDeviceId} onChange={(e) => setDraft({ ...draft, previewDeviceId: e.target.value })}>
              {devices.map((d) => (
                <option key={d.deviceId || 'default'} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="small" onClick={() => void listOutputDevices().then(setDevices)}>
          Aggiorna elenco schede
        </button>
      </section>

      <section className="panel">
        <div className="section-title">Messa in onda e rotazione</div>
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
                value={draft[n.key] as number}
                onChange={(e) => setDraft({ ...draft, [n.key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
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
              const v = Number(clamp[n.key])
              ;(clamp as unknown as Record<string, number>)[n.key] = Math.min(n.max, Math.max(n.min, Number.isFinite(v) ? v : n.min))
            }
            await radio.saveSettings(clamp)
            setSaved(true)
          }}
        >
          Salva
        </button>
      </div>
    </div>
  )
}
