import { AiRotationSection } from './AiRotationSection'
import { useEffect, useState } from 'react'
import { nextOccurrences } from '../../core/events'
import {
  ACTION_LABELS,
  TRACK_KINDS,
  type EventAction,
  type RotationProfile,
  type ScheduledEvent,
  type Track
} from '../../core/types'
import type { PonteProgram } from '../../core/ponteClient'
import type { NewsSource } from '../../core/news'
import { AnnounceTester } from './VoiceSection'
import { hhmm, KIND_LABEL } from './format'
import { TrackSearch } from './TrackSearch'
import type { Radio } from './useRadio'

const DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab']
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

type Draft = Omit<ScheduledEvent, 'id'> & { id?: number }
type RepeatKind = 'once' | 'hourly' | 'every'

const emptyDraft = (): Draft => ({
  label: '',
  time: '',
  days: [0, 1, 2, 3, 4, 5, 6],
  repeatMinutes: 0,
  untilTime: null,
  validFrom: null,
  validTo: null,
  mode: 'soft',
  toleranceSeconds: 0,
  actions: [],
  enabled: true
})

const emptyProfile = (): RotationProfile => ({
  name: '',
  genres: [],
  yearFrom: null,
  yearTo: null,
  artistSeparationMinutes: null,
  jingleEvery: null
})

function newAction(type: EventAction['type']): EventAction {
  switch (type) {
    case 'play':
      return { type, trackId: 0 }
    case 'random':
      return { type, kind: 'jingle', folder: '', genre: '' }
    case 'playlist':
      return { type, path: '', placement: 'front' }
    case 'stream':
      return { type, url: '', minutes: 60, title: '' }
    case 'mode':
      return { type, mode: 'auto' }
    case 'rotation':
      return { type, profile: emptyProfile() }
    case 'command':
      return { type, command: '' }
    case 'replay':
      return { type, programId: '', title: '' }
    case 'news':
      return { type, sourceId: '', title: '' }
    case 'voice':
      return { type, text: 'Sono le {ora}. Avete ascoltato {brano} di {artista}.' }
    default:
      return { type } as EventAction
  }
}

function repeatKind(d: Draft): RepeatKind {
  if (d.time.startsWith('*')) return 'hourly'
  return d.repeatMinutes > 0 ? 'every' : 'once'
}

function whenText(e: ScheduledEvent): string {
  if (e.time.startsWith('*')) return `ogni ora al minuto ${e.time.slice(2)}`
  if (e.repeatMinutes > 0) return `dalle ${e.time} ogni ${e.repeatMinutes} min${e.untilTime ? ` fino alle ${e.untilTime}` : ''}`
  return `alle ${e.time}`
}

function daysText(days: number[]): string {
  if (days.length === 7) return 'tutti i giorni'
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return 'lun-ven'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'weekend'
  return DAY_ORDER.filter((d) => days.includes(d))
    .map((d) => DAYS[d])
    .join(' ')
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

function actionSummary(a: EventAction, tracks: Map<number, Track>): string {
  switch (a.type) {
    case 'play': {
      const t = tracks.get(a.trackId)
      return t ? `${t.artist ? t.artist + ' – ' : ''}${t.title}` : 'brano non trovato'
    }
    case 'random':
      return [a.kind ? KIND_LABEL[a.kind] : 'qualsiasi', a.genre && `genere "${a.genre}"`, a.folder && `da ${a.folder}`]
        .filter(Boolean)
        .join(', ')
    case 'playlist':
      return `${a.path} (${a.placement === 'front' ? 'subito' : a.placement === 'append' ? 'in fondo alla coda' : 'sostituisce la coda'})`
    case 'stream':
      return `${a.title || a.url} per ${a.minutes} min`
    case 'mode':
      return a.mode === 'auto' ? 'passa in automatico' : 'passa in manuale'
    case 'clear':
      return 'svuota la coda'
    case 'stop':
      return 'ferma tutto'
    case 'rotation':
      return a.profile ? `profilo "${a.profile.name || 'senza nome'}"` : 'torna alla rotazione normale'
    case 'command':
      return a.command
    case 'replay':
      return a.programId ? `ultima puntata di "${a.title || a.programId}"` : 'nessun programma scelto'
    case 'news':
      return a.sourceId ? `ultima edizione di "${a.title || a.sourceId}"` : 'nessuna fonte scelta'
    case 'voice':
      return `"${a.text.length > 80 ? `${a.text.slice(0, 77)}…` : a.text}"`
  }
}

export function EventsView({ radio }: { radio: Radio }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [tracks, setTracks] = useState<Map<number, Track>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const loadTracks = async (actions: EventAction[]): Promise<void> => {
    const ids = actions.flatMap((a) => (a.type === 'play' && a.trackId ? [a.trackId] : [])).filter((id) => !tracks.has(id))
    if (!ids.length) return
    const ts = await window.radio.getTracks([...new Set(ids)])
    setTracks((prev) => {
      const m = new Map(prev)
      for (const t of ts) m.set(t.id, t)
      return m
    })
  }

  useEffect(() => {
    void loadTracks(radio.events.flatMap((e) => e.actions))
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const upcoming = nextOccurrences(radio.events, now, 6)
  const profile = radio.settings.rotationProfile

  return (
    <div className="events-view">
      <section className="panel">
        <div className="section-title">
          Eventi programmati
          <button
            className="primary"
            onClick={() => {
              setError(null)
              setDraft(emptyDraft())
            }}
          >
            + Nuovo evento
          </button>
        </div>
        <p className="hint">
          Ogni evento esegue una sequenza di azioni all'orario scelto: brani, jingle casuali, playlist, flussi esterni,
          cambi di modalità o di rotazione, comandi. Gli eventi partono anche in modalità manuale.
        </p>
        <div className="upcoming">
          <b>Prossimi:</b>{' '}
          {upcoming.length
            ? upcoming.map((o, i) => (
                <span key={i} className="tag">
                  {o.at.toDateString() === now.toDateString() ? '' : DAYS[o.at.getDay()] + ' '}
                  {hhmm(o.at)} {o.event.label || ''}
                </span>
              ))
            : 'nessuno'}
        </div>
        {profile && (
          <div className="banner warn inline-banner">
            Rotazione attiva: <b>{profile.name || 'profilo senza nome'}</b>
            {profile.genres.length ? ` · generi: ${profile.genres.join(', ')}` : ''}
            {profile.yearFrom || profile.yearTo ? ` · anni ${profile.yearFrom ?? '…'}–${profile.yearTo ?? '…'}` : ''}
            <button className="small" onClick={() => void radio.saveSettings({ rotationProfile: null })}>
              Torna alla rotazione normale
            </button>
          </div>
        )}
        <table className="table">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Giorni</th>
              <th>Nome</th>
              <th>Azioni</th>
              <th>Partenza</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {radio.events.map((e) => (
              <tr key={e.id} className={e.enabled ? '' : 'disabled'}>
                <td className="mono">{whenText(e)}</td>
                <td>
                  {daysText(e.days)}
                  {(e.validFrom || e.validTo) && (
                    <div className="hint">
                      {e.validFrom ? `dal ${fmtDate(e.validFrom)} ` : ''}
                      {e.validTo ? `al ${fmtDate(e.validTo)}` : ''}
                    </div>
                  )}
                </td>
                <td>{e.label}</td>
                <td>
                  <ol className="action-summary">
                    {e.actions.map((a, i) => (
                      <li key={i}>
                        <b>{ACTION_LABELS[a.type]}</b>: {actionSummary(a, tracks)}
                      </li>
                    ))}
                  </ol>
                </td>
                <td>
                  {e.mode === 'hard'
                    ? 'Subito'
                    : e.toleranceSeconds > 0
                      ? `Dopo il brano (max ${e.toleranceSeconds} s)`
                      : 'Dopo il brano'}
                  {!e.enabled && <div className="hint">disattivato</div>}
                </td>
                <td className="t-actions">
                  <button className="small" title="Esegui adesso" onClick={() => void radio.engine.runEvent(e)}>
                    ▶ Prova
                  </button>
                  <button
                    className="small"
                    onClick={() => {
                      setError(null)
                      setDraft(structuredClone(e))
                    }}
                  >
                    Modifica
                  </button>
                  <button
                    className="small"
                    onClick={() => {
                      const { id: _id, ...copy } = structuredClone(e)
                      setError(null)
                      setDraft({ ...copy, label: `${copy.label} (copia)` })
                    }}
                  >
                    Duplica
                  </button>
                  <button
                    className="small danger"
                    onClick={async () => radio.reloadEvents(await window.radio.deleteEvent(e.id))}
                  >
                    Elimina
                  </button>
                </td>
              </tr>
            ))}
            {radio.events.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  Nessun evento. Esempi: jingle orario casuale ogni ora al minuto 00; alle 18:00 sigla, programma
                  registrato e sigla di chiusura; dalle 22 rotazione "musica tranquilla".
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <AiRotationSection initialText={radio.settings.aiDescription} onEvents={(list) => void radio.reloadEvents(list)} />

      {draft && (
        <EventEditor
          draft={draft}
          setDraft={setDraft}
          tracks={tracks}
          onTrackChosen={(t) => setTracks((prev) => new Map(prev).set(t.id, t))}
          news={radio.settings.news}
          error={error}
          onSave={() => void save()}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  )
}

function EventEditor({
  draft,
  setDraft,
  tracks,
  onTrackChosen,
  news,
  error,
  onSave,
  onClose
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  tracks: Map<number, Track>
  onTrackChosen: (t: Track) => void
  news: NewsSource[]
  error: string | null
  onSave: () => void
  onClose: () => void
}) {
  const [picking, setPicking] = useState<number | null>(null)
  const [adding, setAdding] = useState<EventAction['type']>('play')
  const [genres, setGenres] = useState<string[]>([])
  const rk = repeatKind(draft)

  useEffect(() => {
    void window.radio.listGenres().then(setGenres)
  }, [])

  const setAction = (i: number, a: EventAction): void => {
    const actions = [...draft.actions]
    actions[i] = a
    setDraft({ ...draft, actions })
  }
  const moveAction = (i: number, delta: number): void => {
    const actions = [...draft.actions]
    const j = i + delta
    if (j < 0 || j >= actions.length) return
    ;[actions[i], actions[j]] = [actions[j], actions[i]]
    setDraft({ ...draft, actions })
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body editor wide" onClick={(e) => e.stopPropagation()}>
        <div className="section-title">{draft.id ? 'Modifica evento' : 'Nuovo evento'}</div>

        <div className="form-grid">
          <label>
            <span>Nome</span>
            <input
              value={draft.label}
              placeholder="es. Programma della sera"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            <span>Attivo</span>
          </label>
        </div>

        <div className="subsection">Quando</div>
        <div className="row">
          {(
            [
              ['once', 'Una volta al giorno'],
              ['hourly', 'Ogni ora'],
              ['every', 'Ogni N minuti']
            ] as [RepeatKind, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              className={`small ${rk === k ? 'on' : ''}`}
              onClick={() => {
                if (k === 'hourly') setDraft({ ...draft, time: '*:00', repeatMinutes: 0, untilTime: null })
                else if (k === 'every')
                  setDraft({
                    ...draft,
                    time: draft.time.startsWith('*') ? '' : draft.time,
                    repeatMinutes: draft.repeatMinutes || 30
                  })
                else
                  setDraft({ ...draft, time: draft.time.startsWith('*') ? '' : draft.time, repeatMinutes: 0, untilTime: null })
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="form-grid three">
          {rk === 'hourly' ? (
            <label>
              <span>Al minuto</span>
              <input
                type="number"
                min={0}
                max={59}
                value={Number(draft.time.slice(2))}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    time: `*:${String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, '0')}`
                  })
                }
              />
            </label>
          ) : (
            <label>
              <span>{rk === 'every' ? 'Dalle' : 'Alle'}</span>
              <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
            </label>
          )}
          {rk === 'every' && (
            <>
              <label>
                <span>Ogni (minuti)</span>
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={draft.repeatMinutes}
                  onChange={(e) => setDraft({ ...draft, repeatMinutes: Math.max(1, Number(e.target.value) || 1) })}
                />
              </label>
              <label>
                <span>Fino alle (vuoto = mezzanotte)</span>
                <input
                  type="time"
                  value={draft.untilTime ?? ''}
                  onChange={(e) => setDraft({ ...draft, untilTime: e.target.value || null })}
                />
              </label>
            </>
          )}
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
          <button className="small" onClick={() => setDraft({ ...draft, days: [1, 2, 3, 4, 5] })}>
            Lun-Ven
          </button>
          <button className="small" onClick={() => setDraft({ ...draft, days: [0, 6] })}>
            Weekend
          </button>
          <button className="small" onClick={() => setDraft({ ...draft, days: [0, 1, 2, 3, 4, 5, 6] })}>
            Tutti
          </button>
        </div>
        <div className="form-grid">
          <label>
            <span>Valido dal (facoltativo)</span>
            <input
              type="date"
              value={draft.validFrom ?? ''}
              onChange={(e) => setDraft({ ...draft, validFrom: e.target.value || null })}
            />
          </label>
          <label>
            <span>Valido fino al (facoltativo)</span>
            <input
              type="date"
              value={draft.validTo ?? ''}
              onChange={(e) => setDraft({ ...draft, validTo: e.target.value || null })}
            />
          </label>
        </div>

        <div className="subsection">Partenza rispetto al brano in onda</div>
        <div className="row">
          <button
            className={`small ${draft.mode === 'soft' && !draft.toleranceSeconds ? 'on' : ''}`}
            onClick={() => setDraft({ ...draft, mode: 'soft', toleranceSeconds: 0 })}
          >
            Dopo il brano
          </button>
          <button
            className={`small ${draft.mode === 'soft' && draft.toleranceSeconds > 0 ? 'on' : ''}`}
            onClick={() => setDraft({ ...draft, mode: 'soft', toleranceSeconds: draft.toleranceSeconds || 30 })}
          >
            Dopo il brano, al massimo…
          </button>
          <button
            className={`small ${draft.mode === 'hard' ? 'on' : ''}`}
            onClick={() => setDraft({ ...draft, mode: 'hard', toleranceSeconds: 0 })}
          >
            Subito (sfuma il brano)
          </button>
          {draft.mode === 'soft' && draft.toleranceSeconds > 0 && (
            <label className="inline">
              <input
                type="number"
                min={1}
                max={600}
                value={draft.toleranceSeconds}
                onChange={(e) => setDraft({ ...draft, toleranceSeconds: Math.max(1, Number(e.target.value) || 1) })}
                style={{ width: 80 }}
              />
              secondi, poi sfuma
            </label>
          )}
        </div>

        <div className="subsection">Azioni (in ordine)</div>
        <ol className="action-list">
          {draft.actions.map((a, i) => (
            <li key={i}>
              <div className="action-head">
                <b>
                  {i + 1}. {ACTION_LABELS[a.type]}
                </b>
                <span className="t-actions">
                  <button className="small" disabled={i === 0} onClick={() => moveAction(i, -1)}>
                    ▲
                  </button>
                  <button className="small" disabled={i === draft.actions.length - 1} onClick={() => moveAction(i, 1)}>
                    ▼
                  </button>
                  <button
                    className="small danger"
                    onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </span>
              </div>
              <ActionForm
                action={a}
                onChange={(na) => setAction(i, na)}
                tracks={tracks}
                genres={genres}
                news={news}
                onPick={() => setPicking(i)}
              />
            </li>
          ))}
          {draft.actions.length === 0 && <li className="empty">Nessuna azione: aggiungine almeno una.</li>}
        </ol>
        <div className="row">
          <select value={adding} onChange={(e) => setAdding(e.target.value as EventAction['type'])}>
            {Object.entries(ACTION_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              const actions = [...draft.actions, newAction(adding)]
              setDraft({ ...draft, actions })
              if (adding === 'play') setPicking(actions.length - 1)
            }}
          >
            + Aggiungi azione
          </button>
        </div>

        {error && <div className="banner error">{error}</div>}
        <div className="row end">
          <button onClick={onClose}>Annulla</button>
          <button className="primary" onClick={onSave}>
            Salva
          </button>
        </div>

        {picking != null && (
          <div className="modal" onClick={() => setPicking(null)}>
            <div className="modal-body" onClick={(e) => e.stopPropagation()}>
              <div className="section-title">
                Scegli il brano
                <button className="small" onClick={() => setPicking(null)}>
                  Chiudi
                </button>
              </div>
              <TrackSearch
                autoFocus
                actions={(t) => (
                  <button
                    className="small primary"
                    onClick={() => {
                      onTrackChosen(t)
                      setAction(picking, { type: 'play', trackId: t.id })
                      setPicking(null)
                    }}
                  >
                    Scegli
                  </button>
                )}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ActionForm({
  action: a,
  onChange,
  tracks,
  genres,
  news,
  onPick
}: {
  action: EventAction
  onChange: (a: EventAction) => void
  tracks: Map<number, Track>
  genres: string[]
  news: NewsSource[]
  onPick: () => void
}) {
  switch (a.type) {
    case 'play': {
      const t = tracks.get(a.trackId)
      return (
        <div className="row">
          <span>{t ? `${t.artist ? t.artist + ' – ' : ''}${t.title}` : 'nessun brano scelto'}</span>
          <button className="small" onClick={onPick}>
            Scegli brano
          </button>
        </div>
      )
    }
    case 'random':
      return (
        <div className="form-grid three">
          <label>
            <span>Tipo</span>
            <select value={a.kind} onChange={(e) => onChange({ ...a, kind: e.target.value as typeof a.kind })}>
              <option value="">Qualsiasi</option>
              {TRACK_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Genere (facoltativo)</span>
            <input list="genres" value={a.genre} onChange={(e) => onChange({ ...a, genre: e.target.value })} />
            <datalist id="genres">
              {genres.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label>
            <span>Solo dalla cartella (facoltativo)</span>
            <span className="row tight">
              <input value={a.folder} onChange={(e) => onChange({ ...a, folder: e.target.value })} />
              <button
                className="small"
                onClick={async () => {
                  const p = await window.radio.choosePath('folder')
                  if (p) onChange({ ...a, folder: p })
                }}
              >
                Sfoglia
              </button>
            </span>
          </label>
        </div>
      )
    case 'playlist':
      return (
        <div className="form-grid">
          <label>
            <span>File playlist (M3U, M3U8, PLS) o cartella</span>
            <span className="row tight">
              <input value={a.path} onChange={(e) => onChange({ ...a, path: e.target.value })} />
              <button
                className="small"
                onClick={async () => {
                  const p = await window.radio.choosePath('playlist')
                  if (p) onChange({ ...a, path: p })
                }}
              >
                File…
              </button>
              <button
                className="small"
                onClick={async () => {
                  const p = await window.radio.choosePath('folder')
                  if (p) onChange({ ...a, path: p })
                }}
              >
                Cartella…
              </button>
            </span>
          </label>
          <label>
            <span>Dove metterla</span>
            <select value={a.placement} onChange={(e) => onChange({ ...a, placement: e.target.value as typeof a.placement })}>
              <option value="front">Subito, prima del resto della coda</option>
              <option value="replace">Al posto della coda attuale</option>
              <option value="append">In fondo alla coda</option>
            </select>
          </label>
        </div>
      )
    case 'stream':
      return (
        <div className="form-grid three">
          <label>
            <span>Indirizzo del flusso</span>
            <input
              value={a.url}
              placeholder="https://radio.partner.it/live.mp3"
              onChange={(e) => onChange({ ...a, url: e.target.value })}
            />
          </label>
          <label>
            <span>Per quanti minuti</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={a.minutes}
              onChange={(e) => onChange({ ...a, minutes: Math.max(1, Number(e.target.value) || 1) })}
            />
          </label>
          <label>
            <span>Nome (per il registro)</span>
            <input value={a.title} placeholder="es. GR nazionale" onChange={(e) => onChange({ ...a, title: e.target.value })} />
          </label>
        </div>
      )
    case 'mode':
      return (
        <div className="row">
          <button className={`small ${a.mode === 'auto' ? 'on' : ''}`} onClick={() => onChange({ ...a, mode: 'auto' })}>
            Automatico
          </button>
          <button className={`small ${a.mode === 'manual' ? 'on' : ''}`} onClick={() => onChange({ ...a, mode: 'manual' })}>
            Manuale
          </button>
        </div>
      )
    case 'clear':
      return <div className="hint">Toglie dalla coda tutti i brani in attesa (quello in onda continua).</div>
    case 'stop':
      return <div className="hint">Sfuma tutto quello che è in onda e passa in manuale.</div>
    case 'replay':
      return <ReplayForm action={a} onChange={onChange} />
    case 'voice':
      return <VoiceForm action={a} onChange={onChange} />
    case 'news': {
      const known = news.some((n) => n.id === a.sourceId)
      return (
        <div className="form-grid">
          <label>
            <span>Fonte</span>
            <select
              value={a.sourceId}
              onChange={(e) => onChange({ ...a, sourceId: e.target.value, title: news.find((n) => n.id === e.target.value)?.name ?? '' })}
            >
              <option value="">Scegli…</option>
              {a.sourceId && !known && <option value={a.sourceId}>{a.title || a.sourceId} (fonte tolta)</option>}
              {news.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          <div className="hint">
            {news.length
              ? "All'ora dell'evento scarica l'ultima edizione e la manda in onda. Le fonti si impostano in Impostazioni → Notiziari."
              : 'Nessuna fonte: aggiungila prima in Impostazioni → Notiziari.'}
          </div>
        </div>
      )
    }
    case 'command':
      return (
        <label className="block">
          <span className="hint">Comando di Windows da eseguire (per esempio avviare un programma o uno script .bat)</span>
          <input
            value={a.command}
            placeholder={'"C:\\Script\\avvia-registrazione.bat"'}
            onChange={(e) => onChange({ ...a, command: e.target.value })}
          />
        </label>
      )
    case 'rotation': {
      const p = a.profile
      return (
        <div>
          <div className="row">
            <button className={`small ${p ? 'on' : ''}`} onClick={() => onChange({ ...a, profile: p ?? emptyProfile() })}>
              Attiva un profilo
            </button>
            <button className={`small ${!p ? 'on' : ''}`} onClick={() => onChange({ ...a, profile: null })}>
              Torna alla rotazione normale
            </button>
          </div>
          {p && (
            <div className="form-grid three">
              <label>
                <span>Nome del profilo</span>
                <input
                  value={p.name}
                  placeholder="es. Musica tranquilla"
                  onChange={(e) => onChange({ ...a, profile: { ...p, name: e.target.value } })}
                />
              </label>
              <label>
                <span>Generi (separati da virgola, vuoto = tutti)</span>
                <input
                  list="genres"
                  value={p.genres.join(', ')}
                  onChange={(e) =>
                    onChange({
                      ...a,
                      profile: { ...p, genres: e.target.value.split(',').map((g) => g.trimStart()) }
                    })
                  }
                  onBlur={() => onChange({ ...a, profile: { ...p, genres: p.genres.map((g) => g.trim()).filter(Boolean) } })}
                />
                <datalist id="genres">
                  {genres.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
              <label>
                <span>Anni (da – a)</span>
                <span className="row tight">
                  <input
                    type="number"
                    placeholder="da"
                    value={p.yearFrom ?? ''}
                    onChange={(e) =>
                      onChange({ ...a, profile: { ...p, yearFrom: e.target.value ? Number(e.target.value) : null } })
                    }
                  />
                  <input
                    type="number"
                    placeholder="a"
                    value={p.yearTo ?? ''}
                    onChange={(e) =>
                      onChange({ ...a, profile: { ...p, yearTo: e.target.value ? Number(e.target.value) : null } })
                    }
                  />
                </span>
              </label>
              <label>
                <span>Separazione artista (min, vuoto = come impostazioni)</span>
                <input
                  type="number"
                  value={p.artistSeparationMinutes ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...a,
                      profile: { ...p, artistSeparationMinutes: e.target.value ? Number(e.target.value) : null }
                    })
                  }
                />
              </label>
              <label>
                <span>Un jingle ogni … brani (vuoto = come impostazioni)</span>
                <input
                  type="number"
                  value={p.jingleEvery ?? ''}
                  onChange={(e) =>
                    onChange({ ...a, profile: { ...p, jingleEvery: e.target.value ? Number(e.target.value) : null } })
                  }
                />
              </label>
            </div>
          )}
          {p && (
            <div className="hint">
              Se i filtri lasciano meno di 10 brani, la rotazione usa tutta la musica per non restare a corto di brani.
            </div>
          )}
        </div>
      )
    }
  }
}

/** Replica: si sceglie il programma tra quelli del server; all'ora dell'evento va in onda la sua ultima puntata. */
function ReplayForm({
  action: a,
  onChange
}: {
  action: Extract<EventAction, { type: 'replay' }>
  onChange: (a: EventAction) => void
}) {
  const [programs, setPrograms] = useState<PonteProgram[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.radio
      .ponteListPrograms()
      .then(setPrograms)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  const known = programs?.some((p) => p.id === a.programId)
  const chosen = programs?.find((p) => p.id === a.programId)
  return (
    <div className="form-grid">
      <label>
        <span>Programma</span>
        <select
          value={a.programId}
          onChange={(e) => {
            const p = programs?.find((x) => x.id === e.target.value)
            onChange({ ...a, programId: e.target.value, title: p?.title ?? '' })
          }}
        >
          <option value="">Scegli…</option>
          {a.programId && !known && <option value={a.programId}>{a.title || a.programId}</option>}
          {programs?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} ({p.episodes.length} {p.episodes.length === 1 ? 'puntata' : 'puntate'})
            </option>
          ))}
        </select>
      </label>
      <div className="hint">
        {error
          ? `Elenco dei programmi non disponibile: ${error}`
          : chosen
            ? chosen.episodes[0]
              ? `Adesso andrebbe in onda: ${chosen.episodes[0].title}. L'audio arriva in streaming dal server (serve internet).`
              : 'Questo programma non ha ancora puntate pubblicate.'
            : "All'ora dell'evento va in onda l'ultima puntata pubblicata del programma, in streaming dal server."}
      </div>
    </div>
  )
}

/** Annuncio vocale: testo con le parti che si riempiono da sole, e prova. */
function VoiceForm({ action: a, onChange }: { action: Extract<EventAction, { type: 'voice' }>; onChange: (a: EventAction) => void }) {
  return (
    <div className="voice-form">
      <AnnounceTester text={a.text} onText={(text) => onChange({ ...a, text })} />
    </div>
  )
}
