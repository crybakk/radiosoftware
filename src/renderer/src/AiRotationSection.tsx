import { useEffect, useState } from 'react'
import { AI_LABEL, daysLabel, type AiPlan, type AiSlot } from '../../core/aiRotation'
import type { ScheduledEvent } from '../../core/types'
import type { AiResult, AiStatus } from '../../main/ai'

const EXAMPLE = `Dal lunedì al venerdì dalle 7 alle 10 pop italiano allegro, dalle 10 alle 13 successi degli anni 80 e 90.
Tutti i giorni dalle 22 alle 2 musica tranquilla, jazz e lounge.
Sabato e domenica dalle 9 alle 12 rock, con un jingle ogni 3 brani.`

const DAY_SHORT = ['D', 'L', 'M', 'M', 'G', 'V', 'S']
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)

const numOrNull = (v: string): number | null => (v.trim() === '' ? null : Number(v))

/** Rotazioni generate dall'AI: palinsesto a parole → fasce in anteprima → eventi. */
export function AiRotationSection({
  initialText,
  onEvents
}: {
  initialText: string
  onEvents: (list: ScheduledEvent[]) => void
}) {
  const api = window.radio
  const [open, setOpen] = useState(false)
  const [st, setSt] = useState<AiStatus | null>(null)
  const [text, setText] = useState(initialText)
  const [res, setRes] = useState<AiResult | null>(null)
  const [replace, setReplace] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void api.aiStatus().then(setSt)
    return api.onAiStatus(setSt)
  }, [api])

  const generate = async (): Promise<void> => {
    setErr(null)
    setMsg(null)
    setRes(null)
    try {
      setRes(await api.aiGenerate(text))
    } catch (e) {
      setErr(clean(e))
    }
  }

  /** Dopo una modifica a mano: ricontrolla e ricalcola i brani. */
  const update = async (plan: AiPlan): Promise<void> => {
    setRes((r) => (r ? { ...r, plan } : r))
    try {
      const p = await api.aiPreview(plan)
      setRes((r) => (r ? { ...p, seconds: r.seconds } : p))
    } catch (e) {
      setErr(clean(e))
    }
  }

  const setSlot = (i: number, patch: Partial<AiSlot>): void => {
    if (!res) return
    const slots = res.plan.slots.map((s, j) => (j === i ? { ...s, ...patch } : s))
    setRes({ ...res, plan: { slots } })
  }
  const commit = (): void => {
    if (res) void update(res.plan)
  }

  const apply = async (): Promise<void> => {
    if (!res) return
    setErr(null)
    try {
      const list = await api.aiApply(res.plan, replace)
      onEvents(list)
      setMsg(`Eventi creati: li trovi nell'elenco qui sopra, con il nome che inizia con "${AI_LABEL}".`)
      setRes(null)
    } catch (e) {
      setErr(clean(e))
    }
  }

  if (!st) return null
  const pct = Math.round(st.progress * 100)

  return (
    <section className="panel ai-panel" data-sezione="rotazioni-ai" data-titolo="Rotazioni con l'AI">
      <div className="section-title">
        Rotazioni con l'AI
        <button className="small" onClick={() => setOpen(!open)}>
          {open ? 'Chiudi' : 'Apri'}
        </button>
      </div>
      {!open ? (
        <p className="hint">Scrivi il palinsesto a parole: l'AI prepara le regole di rotazione per ogni fascia oraria.</p>
      ) : (
        <>
          <p className="hint">
            Scrivi a parole cosa vuoi in onda nelle varie fasce (giorni, orari, generi, anni). L'AI, che gira su questo
            PC senza internet, sceglie solo tra i generi della tua libreria. Vedi l'anteprima, la correggi se serve e
            poi crei gli eventi.
          </p>

          {!st.installed ? (
            <div className="ai-model">
              <div>
                Serve il modello <b>{st.modelName}</b> (circa {(st.sizeMb / 1000).toFixed(1).replace('.', ',')} GB, si
                scarica una volta sola).
                {st.downloadedMb > 0 && !st.downloading && ` Già scaricati ${st.downloadedMb} MB: riprende da lì.`}
              </div>
              {st.downloading ? (
                <div className="row">
                  <progress max={100} value={pct} /> {pct}% ({st.downloadedMb} MB)
                  <button className="small" onClick={() => void api.aiCancelDownload()}>
                    Ferma
                  </button>
                </div>
              ) : (
                <button className="primary" onClick={() => void api.aiDownload()}>
                  {st.downloadedMb > 0 ? 'Riprendi lo scaricamento' : 'Scarica il modello'}
                </button>
              )}
            </div>
          ) : (
            <div className="hint">
              Modello: {st.modelName}.{' '}
              <button
                className="small ghost"
                disabled={st.busy}
                onClick={() => {
                  if (confirm('Eliminare il modello? Per usare di nuovo l\'AI andrà riscaricato.')) void api.aiRemoveModel()
                }}
              >
                Elimina il modello
              </button>
            </div>
          )}
          {st.error && <div className="banner error inline-banner">{st.error}</div>}

          <label className="ai-text">
            <span>Palinsesto</span>
            <textarea rows={5} value={text} placeholder={EXAMPLE} onChange={(e) => setText(e.target.value)} maxLength={4000} />
          </label>
          <div className="row">
            <button className="primary" disabled={!st.installed || st.busy || !text.trim()} onClick={() => void generate()}>
              {st.busy ? 'L\'AI sta pensando…' : 'Prepara le fasce'}
            </button>
            {!text && (
              <button className="small ghost" onClick={() => setText(EXAMPLE)}>
                Usa l'esempio
              </button>
            )}
            {st.busy && (
              <>
                <span className="hint">Può volerci qualche minuto; la messa in onda continua.</span>
                <button className="small ghost" onClick={() => void api.aiCancelGenerate()}>
                  Interrompi
                </button>
              </>
            )}
          </div>
          {err && <div className="banner error inline-banner">{err}</div>}
          {msg && <div className="banner ok inline-banner">{msg}</div>}

          {res && (
            <div className="ai-preview">
              <div className="subsection">
                Anteprima{res.seconds > 0 && <span className="hint"> · preparata in {res.seconds} s</span>}
              </div>
              {res.warnings.length > 0 && (
                <ul className="ai-warnings">
                  {res.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              <table className="ai-table">
                <thead>
                  <tr>
                    <th>Fascia</th>
                    <th>Giorni</th>
                    <th>Dalle</th>
                    <th>Alle</th>
                    <th>Generi (vuoto = tutti)</th>
                    <th>Anni</th>
                    <th title="Energia da 1 (calmo) a 10 (molto energico), dall'analisi per il Mix DJ; vuoto = qualsiasi">Energia</th>
                    <th title="Minuti prima di ripetere lo stesso artista (vuoto = come nelle impostazioni)">Sep. artista</th>
                    <th title="Vuoto = come nelle impostazioni">Jingle ogni</th>
                    <th>Brani</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {res.plan.slots.map((s, i) => {
                    const n = res.counts[i] ?? 0
                    return (
                      <tr key={i}>
                        <td>
                          <input value={s.name} onChange={(e) => setSlot(i, { name: e.target.value })} onBlur={commit} />
                        </td>
                        <td title={daysLabel(s.days)}>
                          <div className="ai-days">
                            {DAY_ORDER.map((d) => (
                              <button
                                key={d}
                                className={`tiny ${s.days.includes(d) ? 'on' : ''}`}
                                onClick={() => {
                                  const days = s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d]
                                  if (days.length) void update({ slots: res.plan.slots.map((x, j) => (j === i ? { ...x, days } : x)) })
                                }}
                              >
                                {DAY_SHORT[d]}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td>
                          <input type="time" value={s.start} onChange={(e) => setSlot(i, { start: e.target.value })} onBlur={commit} />
                        </td>
                        <td>
                          <input type="time" value={s.end} onChange={(e) => setSlot(i, { end: e.target.value })} onBlur={commit} />
                        </td>
                        <td>
                          <input
                            value={s.genres.join(', ')}
                            onChange={(e) => setSlot(i, { genres: e.target.value.split(',').map((g) => g.trimStart()) })}
                            onBlur={commit}
                          />
                        </td>
                        <td className="ai-years">
                          <input type="number" value={s.yearFrom ?? ''} onChange={(e) => setSlot(i, { yearFrom: numOrNull(e.target.value) })} onBlur={commit} />
                          –
                          <input type="number" value={s.yearTo ?? ''} onChange={(e) => setSlot(i, { yearTo: numOrNull(e.target.value) })} onBlur={commit} />
                        </td>
                        <td className="ai-years">
                          <input type="number" min={1} max={10} value={s.energyMin ?? ''} onChange={(e) => setSlot(i, { energyMin: numOrNull(e.target.value) })} onBlur={commit} />
                          –
                          <input type="number" min={1} max={10} value={s.energyMax ?? ''} onChange={(e) => setSlot(i, { energyMax: numOrNull(e.target.value) })} onBlur={commit} />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            value={s.artistSeparationMinutes ?? ''}
                            onChange={(e) => setSlot(i, { artistSeparationMinutes: numOrNull(e.target.value) })}
                            onBlur={commit}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            value={s.jingleEvery ?? ''}
                            onChange={(e) => setSlot(i, { jingleEvery: numOrNull(e.target.value) })}
                            onBlur={commit}
                          />
                        </td>
                        <td className={n < 10 ? 'bad' : ''} title={n < 10 ? 'Meno di 10 brani: la regia userà tutta la musica' : ''}>
                          {n}
                          {n < 10 && ' ⚠'}
                        </td>
                        <td>
                          <button
                            className="small ghost"
                            title="Togli la fascia"
                            onClick={() => void update({ slots: res.plan.slots.filter((_, j) => j !== i) })}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="hint">
                Su {res.music} brani di musica. Fuori dalle fasce torna la rotazione normale (tutta la musica). Una fascia
                con meno di 10 brani usa tutta la musica.
              </p>
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                  <span>Sostituisci gli eventi creati prima dall'AI</span>
                </label>
                <button className="primary" disabled={!res.plan.slots.length} onClick={() => void apply()}>
                  Crea gli eventi
                </button>
                <button onClick={() => setRes(null)}>Annulla</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
