import { useEffect, useState } from 'react'
import type { ManagedProgram, ManagedProgramInput, ManagedPrograms } from '../../core/ponteClient'
import { Riquadri } from './Riquadri'

/**
 * Programmi del server gestiti dalla regia (richiesta di cristian, 24/11/2026): come nel pannello
 * (☰ → Programmi), ma senza la revisione delle puntate, che resta nel pannello e su Telegram.
 */

const DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab']
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
type Slot = ManagedProgram['slots'][number]

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)

export function slotText(s: Slot): string {
  const days = DAY_ORDER.filter((d) => s.days.includes(d)).map((d) => DAYS[d])
  const when =
    days.length === 7 ? 'tutti i giorni' : days.length === 5 && [1, 2, 3, 4, 5].every((d) => s.days.includes(d)) ? 'lun-ven' : days.join(' ')
  return `${when} ${s.start}-${s.end}`
}

const emptyProgram = (): ManagedProgramInput => ({
  title: '',
  author: '',
  description: '',
  slots: [{ days: [1, 2, 3, 4, 5], start: '10:00', end: '11:00' }],
  record: true,
  studio: false,
  published: true
})

export function ProgramsView() {
  const api = window.radio
  const [data, setData] = useState<ManagedPrograms | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<ManagedProgramInput | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [art, setArt] = useState<Record<string, string | null>>({})

  const load = async (): Promise<void> => {
    try {
      setData(await api.programsManage())
      setError(null)
    } catch (e) {
      setError(clean(e))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // copertine (una volta per versione della copertina)
  useEffect(() => {
    for (const p of data?.programs ?? []) {
      const key = `${p.id}@${p.artUpdatedAt}`
      if (!p.art || key in art) continue
      setArt((a) => ({ ...a, [key]: null }))
      api.programArt(p.id).then(
        (url) => setArt((a) => ({ ...a, [key]: url })),
        () => {}
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const save = async (): Promise<void> => {
    if (!draft) return
    try {
      setFormError(null)
      setData(await api.programSave(draft))
      setDraft(null)
    } catch (e) {
      setFormError(clean(e))
    }
  }

  const remove = async (p: ManagedProgram): Promise<void> => {
    if (!confirm(`Eliminare il programma "${p.title}"?\n\nSul server si cancellano anche tutte le sue puntate e la copertina.`)) return
    try {
      setData(await api.programDelete(p.id))
    } catch (e) {
      setError(clean(e))
    }
  }

  const chooseArt = async (p: ManagedProgram): Promise<void> => {
    try {
      const r = await api.programChooseArt(p.id)
      if (r) setData(r)
    } catch (e) {
      setError(clean(e))
    }
  }

  const setSlot = (i: number, patch: Partial<Slot>): void => {
    if (!draft) return
    setDraft({ ...draft, slots: draft.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  }

  return (
    <Riquadri className="programs-view" chiave="programmi" nome="Programmi">
      <section className="panel" data-sezione="programmi" data-titolo="Programmi">
        <div className="section-title">
          Programmi
          <span className="spacer" />
          <button className="small" onClick={() => void load()}>
            Aggiorna
          </button>
          <button
            className="primary"
            disabled={!data}
            onClick={() => {
              setFormError(null)
              setDraft(emptyProgram())
            }}
          >
            + Nuovo programma
          </button>
        </div>
        <p className="hint">
          I programmi stanno sul server: sono gli stessi del pannello (☰ → Programmi) e quello che cambi qui si vede subito anche lì.
          Le fasce servono per la registrazione automatica delle puntate, per i titoli quando si parla e per gli annunci. Le puntate
          da rivedere e pubblicare si gestiscono dal pannello o da Telegram.
        </p>
        {error && <div className="banner error inline-banner">{error}</div>}
        {!data && !error && <p className="hint">Carico i programmi dal server…</p>}
        {data && (
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Programma</th>
                <th>Fasce</th>
                <th>Opzioni</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.programs.map((p) => {
                const url = p.art ? art[`${p.id}@${p.artUpdatedAt}`] : null
                return (
                  <tr key={p.id}>
                    <td className="prog-art">{url ? <img src={url} alt="" /> : <div className="prog-art-empty">🎙</div>}</td>
                    <td>
                      <b>{p.title}</b>
                      {p.author && <div className="hint">con {p.author}</div>}
                    </td>
                    <td>{p.slots.length ? p.slots.map((s, i) => <div key={i}>{slotText(s)}</div>) : <span className="hint">nessuna fascia</span>}</td>
                    <td className="hint">
                      {[p.studio ? 'dallo studio' : '', p.record ? 'si registra' : 'non si registra', p.published ? 'visibile nei podcast' : 'nascosto']
                        .filter(Boolean)
                        .join(' · ')}
                    </td>
                    <td className="t-actions">
                      <button
                        className="small"
                        onClick={() => {
                          setFormError(null)
                          setDraft({
                            id: p.id,
                            title: p.title,
                            author: p.author,
                            description: p.description,
                            slots: structuredClone(p.slots),
                            record: p.record,
                            studio: p.studio,
                            published: p.published
                          })
                        }}
                      >
                        Modifica
                      </button>
                      <button className="small" onClick={() => void chooseArt(p)}>
                        Copertina…
                      </button>
                      <button className="small danger" onClick={() => void remove(p)}>
                        Elimina
                      </button>
                    </td>
                  </tr>
                )
              })}
              {data.programs.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    Nessun programma. Creane uno con "+ Nuovo programma".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      {draft && (
        <div className="modal" onClick={() => setDraft(null)}>
          <div className="modal-body editor" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">{draft.id ? 'Modifica programma' : 'Nuovo programma'}</div>
            <div className="form-grid">
              <label>
                <span>Nome</span>
                <input value={draft.title} maxLength={200} autoFocus onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label>
                <span>Conduttori</span>
                <input
                  value={draft.author}
                  maxLength={300}
                  placeholder="Anna Rossi, Luca Bianchi"
                  onChange={(e) => setDraft({ ...draft, author: e.target.value })}
                />
              </label>
            </div>
            <label className="block-label">
              <span>Descrizione</span>
              <textarea rows={3} maxLength={4000} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>

            <div className="section-title">Fasce orarie</div>
            {draft.slots.map((s, i) => (
              <div className="prog-slot" key={i}>
                <div className="days">
                  {DAY_ORDER.map((d) => (
                    <button
                      key={d}
                      className={`small ${s.days.includes(d) ? 'on' : ''}`}
                      onClick={() => setSlot(i, { days: s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d] })}
                    >
                      {DAYS[d]}
                    </button>
                  ))}
                </div>
                <label>
                  dalle <input type="time" value={s.start} onChange={(e) => setSlot(i, { start: e.target.value })} />
                </label>
                <label>
                  alle <input type="time" value={s.end} onChange={(e) => setSlot(i, { end: e.target.value })} />
                </label>
                <button className="small" title="Togli la fascia" onClick={() => setDraft({ ...draft, slots: draft.slots.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            <div className="row">
              <button className="small" onClick={() => setDraft({ ...draft, slots: [...draft.slots, { days: [], start: '10:00', end: '11:00' }] })}>
                + Aggiungi fascia
              </button>
              <span className="hint">Se "alle" è prima di "dalle" la fascia finisce il giorno dopo.</span>
            </div>

            <label className="check">
              <input type="checkbox" checked={draft.record} onChange={(e) => setDraft({ ...draft, record: e.target.checked })} />
              <span>Registra da solo le puntate nelle fasce</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.studio} onChange={(e) => setDraft({ ...draft, studio: e.target.checked })} />
              <span>Va in onda dallo studio (la regia lo registra anche lei)</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.published} onChange={(e) => setDraft({ ...draft, published: e.target.checked })} />
              <span>Visibile nella pagina dei podcast e nell'app</span>
            </label>

            {formError && <div className="banner error inline-banner">{formError}</div>}
            <div className="row">
              <button className="primary" onClick={() => void save()}>
                Salva
              </button>
              <button onClick={() => setDraft(null)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </Riquadri>
  )
}
