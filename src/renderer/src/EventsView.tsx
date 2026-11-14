import { useEffect, useState } from 'react'
import type { ScheduledEvent, Track } from '../../core/types'
import { TrackSearch } from './TrackSearch'
import type { Radio } from './useRadio'

const DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab']
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

type Draft = Omit<ScheduledEvent, 'id'> & { id?: number }

const emptyDraft = (): Draft => ({
  time: '',
  days: [0, 1, 2, 3, 4, 5, 6],
  trackId: 0,
  mode: 'soft',
  enabled: true,
  label: ''
})

export function EventsView({ radio }: { radio: Radio }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftTrack, setDraftTrack] = useState<Track | null>(null)
  const [tracks, setTracks] = useState<Map<number, Track>>(new Map())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.radio
      .getTracks([...new Set(radio.events.map((e) => e.trackId))])
      .then((ts) => setTracks(new Map(ts.map((t) => [t.id, t]))))
  }, [radio.events])

  const save = async (): Promise<void> => {
    if (!draft) return
    try {
      setError(null)
      await radio.reloadEvents(await window.radio.saveEvent(draft))
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }

  return (
    <div className="events-view">
      <section className="panel">
        <div className="section-title">
          Eventi a orario fisso
          <button
            className="primary"
            onClick={() => {
              setDraft(emptyDraft())
              setDraftTrack(null)
            }}
          >
            + Nuovo evento
          </button>
        </div>
        <p className="hint">
          <b>Dopo il brano</b>: parte appena finisce il brano in onda, senza tagliarlo. <b>All'orario esatto</b>: sfuma
          il brano in onda e parte subito. Gli eventi partono anche in modalità manuale.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Orario</th>
              <th>Giorni</th>
              <th>Nome</th>
              <th>Brano</th>
              <th>Modo</th>
              <th>Attivo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {radio.events.map((e) => {
              const t = tracks.get(e.trackId)
              return (
                <tr key={e.id} className={e.enabled ? '' : 'disabled'}>
                  <td className="mono">{e.time.startsWith('*') ? `ogni ora :${e.time.slice(2)}` : e.time}</td>
                  <td>{e.days.length === 7 ? 'Tutti' : DAY_ORDER.filter((d) => e.days.includes(d)).map((d) => DAYS[d]).join(' ')}</td>
                  <td>{e.label}</td>
                  <td>{t ? `${t.artist ? t.artist + ' – ' : ''}${t.title}` : '—'}</td>
                  <td>{e.mode === 'hard' ? "All'orario esatto" : 'Dopo il brano'}</td>
                  <td>{e.enabled ? 'Sì' : 'No'}</td>
                  <td className="t-actions">
                    <button
                      className="small"
                      onClick={() => {
                        setDraft({ ...e })
                        setDraftTrack(t ?? null)
                      }}
                    >
                      Modifica
                    </button>
                    <button
                      className="small danger"
                      onClick={async () => radio.reloadEvents(await window.radio.deleteEvent(e.id))}
                    >
                      Elimina
                    </button>
                  </td>
                </tr>
              )
            })}
            {radio.events.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  Nessun evento. Esempio: jingle orario alle 00 di ogni ora, sigla del programma alle 18:00.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {draft && (
        <div className="modal" onClick={() => setDraft(null)}>
          <div className="modal-body editor" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">{draft.id ? 'Modifica evento' : 'Nuovo evento'}</div>
            <div className="form-grid">
              {draft.time.startsWith('*') ? (
                <label>
                  <span>Minuto di ogni ora</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={Number(draft.time.slice(2))}
                    onChange={(e) =>
                      setDraft({ ...draft, time: `*:${String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, '0')}` })
                    }
                  />
                </label>
              ) : (
                <label>
                  <span>Orario</span>
                  <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
                </label>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.time.startsWith('*')}
                  onChange={(e) => setDraft({ ...draft, time: e.target.checked ? '*:00' : '' })}
                />
                <span>Ogni ora (per esempio il jingle orario)</span>
              </label>
              <label>
                <span>Nome</span>
                <input
                  value={draft.label}
                  placeholder="es. Sigla mattino"
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                />
              </label>
              <label>
                <span>Modo</span>
                <select
                  value={draft.mode}
                  onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })}
                >
                  <option value="soft">Dopo il brano in onda</option>
                  <option value="hard">All'orario esatto</option>
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                <span>Attivo</span>
              </label>
            </div>
            <div className="days">
              {DAY_ORDER.map((d) => (
                <button
                  key={d}
                  className={`small ${draft.days.includes(d) ? 'on' : ''}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d]
                    })
                  }
                >
                  {DAYS[d]}
                </button>
              ))}
            </div>
            <div className="chosen">
              Brano: <b>{draftTrack ? `${draftTrack.artist ? draftTrack.artist + ' – ' : ''}${draftTrack.title}` : 'nessuno'}</b>
            </div>
            <div className="picker">
              <TrackSearch
                limit={50}
                actions={(t) => (
                  <button
                    className="small primary"
                    onClick={() => {
                      setDraft({ ...draft, trackId: t.id })
                      setDraftTrack(t)
                    }}
                  >
                    Scegli
                  </button>
                )}
              />
            </div>
            {error && <div className="banner error">{error}</div>}
            <div className="row end">
              <button onClick={() => setDraft(null)}>Annulla</button>
              <button
                className="primary"
                disabled={!draft.time || !draft.trackId || !draft.days.length}
                onClick={() => void save()}
              >
                Salva
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
