import { useEffect, useState } from 'react'
import type { ServerSyncStatus, ServerTrackRow } from '../../main/serverSync'
import type { PonteSettings } from '../../core/types'
import { cleanError } from './ConnectionView'

const api = window.radio

/**
 * Libreria del server per la diretta autonoma: quali brani ci vanno, prima copia su disco USB,
 * invio dei brani nuovi via internet (di notte, con un limite al giorno).
 */
export function ServerLibrarySection({
  draft,
  set
}: {
  draft: PonteSettings
  set: <K extends keyof PonteSettings>(k: K, v: PonteSettings[K]) => void
}) {
  const [st, setSt] = useState<ServerSyncStatus | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [filter, setFilter] = useState<'esclusi' | 'tutti'>('esclusi')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<ServerTrackRow[] | null>(null)

  useEffect(() => {
    void api.serverSyncStatus().then(setSt)
    return api.onServerSyncStatus(setSt)
  }, [])

  const load = async (): Promise<void> => setRows(await api.serverSyncList(filter, q))
  useEffect(() => {
    if (rows) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  const run = async (fn: () => Promise<string | null | void>): Promise<void> => {
    setMsg(null)
    try {
      const text = await fn()
      if (text) setMsg({ kind: 'ok', text })
    } catch (e) {
      setMsg({ kind: 'error', text: cleanError(e) })
    } finally {
      setSt(await api.serverSyncStatus())
    }
  }

  const choose = async (r: ServerTrackRow, choice: boolean | null): Promise<void> => {
    await api.serverSyncChoice(r.id, choice)
    await load()
    setSt(await api.serverSyncStatus())
  }

  const num = (k: keyof PonteSettings, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, Math.min(max, Math.max(min, Number(e.target.value) || min)) as never)

  return (
    <section className="panel">
      <div className="section-title">Libreria sul server (diretta autonoma)</div>
      <p className="hint">
        Sul server va solo una selezione: niente live, interviste e file sotto i {draft.libraryMinKbps} kbps. Puoi includere o
        escludere a mano qualsiasi brano. La prima volta copia la selezione su un disco USB e portala sul server (vedi la guida);
        dopo, la regia invia da sola solo i brani nuovi o cambiati.
      </p>
      {st && (
        <div className="link-status">
          <strong>
            {st.selected} brani nella selezione ({(st.selectedMb / 1024).toFixed(1)} GB), {st.excluded} esclusi
          </strong>
          {st.onServer != null && <span className="info-line">sul server: {st.onServer}</span>}
          {st.toUpload != null && (
            <span className="info-line">
              da inviare: {st.toUpload} ({st.toUploadMb} MB)
            </span>
          )}
          <span className="info-line">
            inviati oggi: {st.uploadedTodayMb} di {draft.libraryDailyMb} MB
          </span>
        </div>
      )}
      {st?.running && <p className="hint">⏳ {st.running === 'copia' ? 'Copia su disco' : 'Invio al server'}: {st.progress}</p>}
      {st?.lastResult && !st.running && <p className="hint">Ultima operazione: {st.lastResult}</p>}
      {st?.lastError && !st.running && <div className="banner error inline-banner">{st.lastError}</div>}
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'} inline-banner`}>{msg.text}</div>}
      <div className="button-row">
        <button disabled={!!st?.running} onClick={() => void run(() => api.serverSyncExport())}>
          Copia la selezione su disco…
        </button>
        <button disabled={!!st?.running} onClick={() => void run(() => api.serverSyncNow())}>
          Invia ora i brani nuovi
        </button>
        {st?.running && <button onClick={() => void api.serverSyncStop()}>Interrompi</button>}
      </div>

      <div className="form-grid">
        <label className="check">
          <input type="checkbox" checked={draft.librarySync} onChange={(e) => set('librarySync', e.target.checked)} />
          <span>Invia da solo i brani nuovi al server</span>
        </label>
        <label>
          <span>Ore di invio</span>
          <span className="inline-inputs">
            dalle <input type="number" value={draft.librarySyncFrom} onChange={num('librarySyncFrom', 0, 23)} /> alle{' '}
            <input type="number" value={draft.librarySyncTo} onChange={num('librarySyncTo', 0, 23)} />
          </span>
        </label>
        <label>
          <span>
            Massimo al giorno (MB) <em>· traffico del 4G</em>
          </span>
          <input type="number" step={256} value={draft.libraryDailyMb} onChange={num('libraryDailyMb', 0, 100_000)} />
        </label>
        <label>
          <span>Qualità minima (kbps)</span>
          <input type="number" step={32} value={draft.libraryMinKbps} onChange={num('libraryMinKbps', 0, 320)} />
        </label>
      </div>
      <p className="hint">Queste impostazioni si salvano con "Salva" in "Impostazioni del collegamento", qui sopra.</p>

      <div className="section-title">Scegli a mano</div>
      <form
        className="search-row"
        onSubmit={(e) => {
          e.preventDefault()
          void load()
        }}
      >
        <select value={filter} onChange={(e) => setFilter(e.target.value as 'esclusi' | 'tutti')}>
          <option value="esclusi">Esclusi e scelti a mano</option>
          <option value="tutti">Tutta la musica</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titolo o artista" />
        <button type="submit">Mostra</button>
      </form>
      {rows && (
        <table className="table server-list">
          <tbody>
            {!rows.length && (
              <tr>
                <td className="hint">Nessun brano</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.title}</strong>
                  <div className="hint">{r.artist}</div>
                </td>
                <td className="hint">
                  {r.choice === null ? (r.reason ?? 'va sul server') : r.choice ? 'incluso a mano' : 'escluso a mano'}
                </td>
                <td>{r.selected ? '✔ sul server' : '✘ no'}</td>
                <td className="button-row">
                  {r.choice !== null ? (
                    <button className="small" onClick={() => void choose(r, null)} title={r.reason ?? 'va sul server'}>
                      Lascia decidere alla regola
                    </button>
                  ) : r.selected ? (
                    <button className="small" onClick={() => void choose(r, false)}>
                      Escludi
                    </button>
                  ) : (
                    <button className="small" onClick={() => void choose(r, true)}>
                      Includi comunque
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
