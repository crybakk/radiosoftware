import { useEffect, useState } from 'react'
import type { Settings } from '../../core/types'
import { listOutputDevices } from './audio'
import type { Radio } from './useRadio'

const NUMBERS: { key: keyof Settings; label: string; hint: string; min: number; max: number; step?: number }[] = [
  { key: 'crossfadeSeconds', label: 'Dissolvenza (secondi)', hint: 'Usata quando premi AVANTI', min: 0, max: 15, step: 0.5 },
  { key: 'targetLoudness', label: 'Volume obiettivo (LUFS)', hint: 'Tutti i brani vengono livellati a questo valore. -16 è uno standard comune per lo streaming', min: -24, max: -9 },
  { key: 'artistSeparationMinutes', label: 'Separazione artista (minuti)', hint: 'Tempo minimo prima di ripetere lo stesso artista', min: 0, max: 600 },
  { key: 'titleSeparationMinutes', label: 'Separazione brano (minuti)', hint: 'Tempo minimo prima di ripetere lo stesso brano', min: 0, max: 2880 },
  { key: 'jingleEvery', label: 'Un jingle ogni … brani', hint: '0 = nessun jingle automatico', min: 0, max: 20 },
  { key: 'autoQueueLength', label: 'Brani in coda in automatico', hint: 'Quanti brani preparare in anticipo', min: 2, max: 20 }
]

export function SettingsView({ radio }: { radio: Radio }) {
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([])
  const [draft, setDraft] = useState<Settings>(radio.settings)
  const [saved, setSaved] = useState(false)

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

      <div className="row end sticky">
        {saved && !dirty && <span className="hint">Impostazioni salvate</span>}
        <button disabled={!dirty} onClick={() => setDraft(radio.settings)}>
          Annulla modifiche
        </button>
        <button
          className="primary"
          disabled={!dirty}
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
