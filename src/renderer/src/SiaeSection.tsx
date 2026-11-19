import { useEffect, useRef, useState } from 'react'
import { missingFields, quarterOf, type SiaeRow } from '../../core/siae'
import type { Track } from '../../core/types'
import { TrackEditor } from './LibraryView'
import { cleanError } from './ConnectionView'

const api = window.radio

/**
 * Report SIAE trimestrale: una riga per opera con il numero di passaggi, da tutte le fonti
 * (regia, diretta autonoma e musica di riserva del server). Prima di salvare si vedono le opere
 * a cui manca qualcosa e si completano dalla scheda brano.
 */
export function SiaeSection() {
  // di solito si prepara il report del trimestre appena finito
  const prev = quarterOf(new Date(new Date().getFullYear(), new Date().getMonth() - 3, 1))
  const [year, setYear] = useState(prev.year)
  const [q, setQ] = useState(prev.q)
  const [rows, setRows] = useState<SiaeRow[] | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [editing, setEditing] = useState<Track | null>(null)
  // cambiando trimestre mentre il calcolo precedente è in corso, conta solo l'ultima richiesta
  const loadSeq = useRef(0)

  const load = async (): Promise<void> => {
    const seq = ++loadSeq.current
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.siaeReport(year, q)
      if (seq !== loadSeq.current) return
      setRows(r.rows)
      setServerError(r.serverError)
    } catch (e) {
      if (seq === loadSeq.current) setMsg({ kind: 'error', text: cleanError(e) })
    } finally {
      if (seq === loadSeq.current) setBusy(false)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, q])

  const years = Array.from({ length: 4 }, (_, i) => new Date().getFullYear() - i)
  const incomplete = rows?.filter((r) => missingFields(r).length > 0) ?? []
  const shown = (onlyMissing ? incomplete : (rows ?? [])).slice(0, 500)
  const uses = rows?.reduce((a, r) => a + r.uses, 0) ?? 0

  return (
    <section className="panel" data-sezione="siae" data-titolo="Report SIAE">
      <div className="section-title">Report SIAE trimestrale</div>
      <div className="row">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select value={q} onChange={(e) => setQ(Number(e.target.value))}>
          <option value={1}>1° trimestre (gennaio-marzo)</option>
          <option value={2}>2° trimestre (aprile-giugno)</option>
          <option value={3}>3° trimestre (luglio-settembre)</option>
          <option value={4}>4° trimestre (ottobre-dicembre)</option>
        </select>
        <button onClick={() => void load()} disabled={busy}>
          {busy ? 'Calcolo…' : 'Aggiorna'}
        </button>
        <button
          className="primary"
          disabled={busy || !rows?.length}
          onClick={async () => {
            try {
              const path = await api.exportSiaeCsv(year, q)
              if (path) setMsg({ kind: 'ok', text: `Salvato in ${path}` })
            } catch (e) {
              setMsg({ kind: 'error', text: cleanError(e) })
            }
          }}
        >
          Salva CSV per il portale SIAE
        </button>
      </div>
      {rows && (
        <div className="hint">
          {rows.length} {rows.length === 1 ? 'opera' : 'opere'}, {uses} {uses === 1 ? 'utilizzazione' : 'utilizzazioni'} (regia, diretta autonoma e musica di riserva del server; i
          passaggi della regia sotto i 30 secondi non contano).{' '}
          {incomplete.length > 0
            ? `${incomplete.length === 1 ? "1 opera ha" : `${incomplete.length} opere hanno`} dati mancanti: completale dalla scheda prima di salvare.`
            : 'Tutte le opere hanno autori, editore e almeno un codice.'}
        </div>
      )}
      {serverError && (
        <div className="banner error inline-banner">
          Brani suonati dal server non aggiornati ({serverError}): il report contiene quelli scaricati finora.
        </div>
      )}
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'} inline-banner`}>{msg.text}</div>}
      {rows && rows.length > 0 && (
        <>
          <label className="check">
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
            <span>Solo le opere con dati mancanti</span>
          </label>
          <div className="siae-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Titolo</th>
                  <th>Interprete</th>
                  <th>Autori</th>
                  <th>Editore</th>
                  <th>Passaggi</th>
                  <th>Cod. opera</th>
                  <th>ISWC</th>
                  <th>ISRC</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const noCode = !r.siaeCode && !r.iswc && !r.isrc
                  return (
                    <tr key={`${r.title}|${r.performer}`}>
                      <td>{r.title}</td>
                      <td>{r.performer}</td>
                      <td className={r.authors ? '' : 'missing'}>{r.authors || 'manca'}</td>
                      <td className={r.publisher ? '' : 'missing'}>{r.publisher || 'manca'}</td>
                      <td className="mono">{r.uses}</td>
                      <td className={noCode ? 'missing' : ''}>{r.siaeCode || '—'}</td>
                      <td className={noCode ? 'missing' : ''}>{r.iswc || '—'}</td>
                      <td className={noCode ? 'missing' : ''}>{r.isrc || '—'}</td>
                      <td>
                        {r.trackId != null ? (
                          <button
                            className="small"
                            onClick={async () => {
                              const t = await api.getTrack(r.trackId!)
                              if (t) setEditing(t)
                            }}
                          >
                            Scheda
                          </button>
                        ) : (
                          <span className="hint" title="Brano caricato sul server dal pannello: non è nella libreria della regia">
                            solo server
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing && (
        <TrackEditor
          track={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </section>
  )
}
