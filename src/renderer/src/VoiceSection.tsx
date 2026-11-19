import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { DEFAULT_VOICE, PLACEHOLDERS, type VoiceSettings } from '../../../ponte/controllo/src/annunci.ts'
import type { Settings, Track } from '../../core/types'
import type { VoiceState } from '../../shared/api'
import type { PreviewPlayer } from './audio'
import { mmss } from './format'

/** Preascolto condiviso (la stessa uscita scelta nelle impostazioni). */
export const PreviewContext = createContext<PreviewPlayer | null>(null)

const errText = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)

/** Testo dell'annuncio con i pulsanti delle parti automatiche e la prova in preascolto. */
export function AnnounceTester({ text, onText, voice, radio }: { text: string; onText: (t: string) => void; voice?: VoiceSettings; radio?: string }) {
  const preview = useContext(PreviewContext)
  const area = useRef<HTMLTextAreaElement>(null)
  const [test, setTest] = useState<{ busy: boolean; note: string; track: Track | null } | null>(null)
  const insert = (key: string): void => {
    const el = area.current
    const tag = `{${key}}`
    if (!el) return onText(text + tag)
    const a = el.selectionStart ?? text.length
    const b = el.selectionEnd ?? text.length
    onText(text.slice(0, a) + tag + text.slice(b))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(a + tag.length, a + tag.length)
    })
  }
  return (
    <div className="announce">
      <textarea ref={area} rows={3} value={text} maxLength={3000} onChange={(e) => onText(e.target.value)} placeholder="Testo da leggere" />
      <div className="placeholders">
        <span className="hint">Inserisci:</span>
        {PLACEHOLDERS.map((p) => (
          <button key={p.key} className="small ghost" title={p.help} onClick={() => insert(p.key)}>
            {`{${p.key}}`}
          </button>
        ))}
      </div>
      <div className="row">
        <button
          className="small"
          disabled={!!test?.busy || !text.trim()}
          onClick={async () => {
            setTest({ busy: true, note: 'Preparo la voce… (la prima volta la scarica: può volerci qualche minuto)', track: null })
            try {
              const r = await window.radio.voiceTest(text, voice, radio === undefined ? undefined : { radio })
              setTest({ busy: false, ...r })
              if (r.track && preview) await preview.play(window.radio.mediaUrl(r.track), r.track.id)
            } catch (e) {
              setTest({ busy: false, note: errText(e), track: null })
            }
          }}
        >
          🎧 Ascolta in preascolto
        </button>
        {test?.track && (
          <button className="small" onClick={() => preview?.stop()}>
            ■ Ferma
          </button>
        )}
        {test && (
          <span className="hint">
            {test.track ? `"${test.track.title}" · ${mmss(test.track.duration)}` : ''}
            {test.note ? ` ${test.note}` : ''}
          </span>
        )}
      </div>
      <div className="hint">
        Nella prova {'{brano}'} e {'{artista}'} sono di esempio; in onda sono quelli veri. {'{programma}'} viene dal palinsesto del
        server.
      </div>
    </div>
  )
}

const SLIDERS: { key: keyof Omit<VoiceSettings, 'voice'>; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { key: 'speed', label: 'Velocità', min: 0.5, max: 2, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'expressiveness', label: 'Espressività (intonazione)', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'rhythm', label: 'Variazione del ritmo', min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'sentencePause', label: 'Pausa tra le frasi', min: 0, max: 3, step: 0.1, fmt: (v) => `${v.toFixed(1)} s` },
  { key: 'pitch', label: 'Tono', min: -6, max: 6, step: 0.5, fmt: (v) => (v === 0 ? 'normale' : `${v > 0 ? '+' : ''}${v} semitoni`) },
  { key: 'volumeDb', label: 'Volume', min: -12, max: 12, step: 0.5, fmt: (v) => (v === 0 ? 'normale' : `${v > 0 ? '+' : ''}${v} dB`) }
]

/** Impostazioni della voce sintetica (scheda Impostazioni). */
export function VoiceSection({ draft, setDraft }: { draft: Settings; setDraft: (s: Settings) => void }) {
  const [voices, setVoices] = useState<VoiceState[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sample, setSample] = useState('Sono le {ora}. Avete ascoltato {brano} di {artista}. Qui {radio}.')
  const v = draft.voice
  const setV = (x: Partial<VoiceSettings>): void => setDraft({ ...draft, voice: { ...v, ...x } })

  useEffect(() => {
    void window.radio.voiceList().then(setVoices)
  }, [])
  // durante lo scaricamento si aggiorna lo stato ogni pochi secondi
  const downloading = voices.some((x) => x.downloading)
  useEffect(() => {
    if (!downloading) return
    const t = setInterval(() => void window.radio.voiceList().then(setVoices), 3000)
    return () => clearInterval(t)
  }, [downloading])

  const chosen = voices.find((x) => x.id === v.voice)
  return (
    <section className="panel" data-sezione="voce" data-titolo="Voce sintetica">
      <div className="section-title">Voce sintetica</div>
      <p className="hint">
        Per gli annunci (azione "Annuncio vocale" negli eventi) e, se lo scegli, al posto di un notiziario che manca. Gratuita e
        senza internet: serve solo la prima volta per scaricare la voce.
      </p>
      <div className="form-grid">
        <label>
          <span>Voce</span>
          <select value={v.voice} onChange={(e) => setV({ voice: e.target.value })}>
            {voices.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}, {x.description} {x.installed ? '' : `(da scaricare, ${x.sizeMb} MB)`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>
            Nome della radio <em>· per {'{radio}'}</em>
          </span>
          <input value={draft.radioName} placeholder="es. Radio Attiva" onChange={(e) => setDraft({ ...draft, radioName: e.target.value })} />
        </label>
      </div>
      <div className="row">
        {chosen && !chosen.installed && (
          <button
            className="small"
            disabled={chosen.downloading}
            onClick={async () => {
              setError(null)
              const p = window.radio.voiceInstall(chosen.id).then(setVoices)
              setVoices(await window.radio.voiceList())
              await p.catch((e: unknown) => setError(errText(e)))
              setVoices(await window.radio.voiceList())
            }}
          >
            {chosen.downloading ? 'Scarico la voce…' : `Scarica ${chosen.name} adesso`}
          </button>
        )}
        {voices
          .filter((x) => x.installed && x.id !== v.voice)
          .map((x) => (
            <button
              key={x.id}
              className="small ghost"
              title="Libera spazio sul disco: si può riscaricare quando serve"
              onClick={async () => setVoices(await window.radio.voiceRemove(x.id))}
            >
              Togli {x.name} dal disco
            </button>
          ))}
        {error && <span className="hint error-text">{error}</span>}
      </div>
      <div className="form-grid sliders">
        {SLIDERS.map((s) => (
          <label key={s.key}>
            <span>
              {s.label} <em>· {s.fmt(v[s.key])}</em>
            </span>
            <input type="range" min={s.min} max={s.max} step={s.step} value={v[s.key]} onChange={(e) => setV({ [s.key]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      <button className="small" onClick={() => setV({ ...DEFAULT_VOICE, voice: v.voice })}>
        Valori normali
      </button>
      <div className="subsection">Prova (con le impostazioni qui sopra, anche prima di salvare)</div>
      <AnnounceTester text={sample} onText={setSample} voice={v} radio={draft.radioName} />
    </section>
  )
}
