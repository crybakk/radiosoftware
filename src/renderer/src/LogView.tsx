import { useEffect, useState } from 'react'
import type { LogEntry } from '../../core/types'
import { KIND_LABEL, mmss } from './format'

/** Mezzanotte locale del giorno "AAAA-MM-GG"; null se la data è vuota o non valida (campo cancellato). */
export function dayStart(s: string): Date | null {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Intervallo [inizio di `from`, fine di `to`) in ISO; null se una delle due date non è valida. */
export function logRange(from: string, to: string): [string, string] | null {
  const start = dayStart(from)
  const end = dayStart(to)
  if (!start || !end) return null
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function LogView() {
  const today = isoDay(new Date())
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [saved, setSaved] = useState<string | null>(null)

  const range = logRange(from, to)

  useEffect(() => {
    // data cancellata o incompleta: resta l'ultimo elenco finché non è di nuovo valida
    if (!range) return
    const [a, b] = range
    void window.radio.listLog(a, b).then(setEntries)
    const t = setInterval(() => void window.radio.listLog(a, b).then(setEntries), 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to])

  const music = entries.filter((e) => e.kind === 'music')
  const incomplete = music.filter((e) => !e.composer || !e.siaeCode).length

  return (
    <div className="log-view">
      <section className="panel grow">
        <div className="section-title">Registro di trasmissione</div>
        <div className="row">
          <label className="inline">
            Dal <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="inline">
            al <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={!range}
            title={range ? undefined : 'Indica le date del periodo'}
            onClick={async () => {
              if (!range) return
              const [a, b] = range
              setSaved(await window.radio.exportLogCsv(a, b))
            }}
          >
            Esporta CSV
          </button>
          {saved && <span className="hint">Salvato in {saved}</span>}
        </div>
        <div className="hint">
          {entries.length} passaggi, di cui {music.length} brani musicali.
          {incomplete > 0 && ` ${incomplete} brani senza autori o codice SIAE: completali dalla scheda brano in Libreria.`}{' '}
          Il report SIAE nel formato del fac simile arriva con la fase 7.
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Ora</th>
              <th>Durata</th>
              <th>Tipo</th>
              <th>Titolo</th>
              <th>Interprete</th>
              <th>Autori</th>
              <th>Cod. SIAE</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="mono">
                  {new Date(e.startedAt).toLocaleString('it-IT', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  })}
                </td>
                <td className="mono">{e.endedAt ? mmss(e.playedSeconds) : 'in onda'}</td>
                <td>{KIND_LABEL[e.kind]}</td>
                <td>{e.title}</td>
                <td>{e.artist}</td>
                <td className={e.kind === 'music' && !e.composer ? 'missing' : ''}>{e.composer || '—'}</td>
                <td className={e.kind === 'music' && !e.siaeCode ? 'missing' : ''}>{e.siaeCode || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
