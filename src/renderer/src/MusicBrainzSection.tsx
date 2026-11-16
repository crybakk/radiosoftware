import { useEffect, useState } from 'react'
import type { MbStatus } from '../../main/musicbrainz'
import type { Track } from '../../core/types'

const api = window.radio

/** Completamento di autori, editore, ISWC, ISRC e generi con MusicBrainz, e musica ancora incompleta. */
export function MusicBrainzSection({ onEdit, refreshKey }: { onEdit: (t: Track) => void; refreshKey: string }) {
  const [st, setSt] = useState<MbStatus | null>(null)
  const [list, setList] = useState<{ tracks: Track[]; total: number } | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => api.onMbStatus(setSt), [])
  // dopo una scansione o una correzione dalla scheda
  useEffect(() => {
    void api.mbStatus().then(setSt)
  }, [refreshKey])
  useEffect(() => {
    void api.incompleteMusic().then(setList)
  }, [refreshKey, st?.running, st?.checked, open])

  if (!st) return null
  // circa due richieste al secondo per brano, una al secondo concessa da MusicBrainz
  const hours = Math.ceil((st.todo * 2.2) / 3600)

  return (
    <section className="panel mb-panel">
      <div className="section-title">Dati per il report SIAE e generi</div>
      <p className="hint">
        MusicBrainz completa autori, editore, ISWC e ISRC dove mancano: i dati scritti a mano non vengono toccati. Il
        codice opera SIAE non è su MusicBrainz e va scritto nella scheda. Legge anche i generi (per le rotazioni) e
        l'anno, se nel file manca.
      </p>
      <div>
        {st.running
          ? `Ricerca in corso: ${st.doneNow} brani controllati, ne restano ${st.todo}. Ora: ${st.current}`
          : st.todo > 0
            ? `${st.todo} brani di musica da cercare (circa ${hours} ${hours === 1 ? 'ora' : 'ore'}; puoi fermare e riprendere quando vuoi).`
            : 'Tutti i brani di musica sono stati cercati.'}{' '}
        {st.checked > 0 && `Già cercati ${st.checked}, trovati ${st.found}.`}
      </div>
      {st.lastError && <div className="banner error inline-banner">Ricerca fermata: {st.lastError}</div>}
      <div className="row">
        {st.running ? (
          <button onClick={() => void api.mbStop()}>Ferma</button>
        ) : (
          <button className="primary" disabled={!st.todo} onClick={() => void api.mbStart()}>
            Cerca su MusicBrainz
          </button>
        )}
        <button disabled={st.running} onClick={async () => setSt(await api.mbRetry())} title="Rimette in coda i brani già cercati che sono ancora incompleti">
          Riprova i brani non trovati
        </button>
        {list && (
          <button onClick={() => setOpen(!open)}>
            {open ? 'Nascondi' : 'Mostra'} la musica con dati mancanti ({list.total})
          </button>
        )}
      </div>
      {open && list && (
        <div className="siae-table">
          <table className="table">
            <thead>
              <tr>
                <th>Interprete</th>
                <th>Titolo</th>
                <th>Manca</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.tracks.map((t) => (
                <tr key={t.id}>
                  <td>{t.artist}</td>
                  <td>{t.title}</td>
                  <td className="missing">
                    {[
                      !t.composer && 'autori',
                      !t.publisher && 'editore',
                      !t.siaeCode && !t.iswc && !t.isrc && 'codice'
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </td>
                  <td>
                    <button className="small" onClick={() => onEdit(t)}>
                      Scheda
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.total > list.tracks.length && <div className="hint">Mostrati i primi {list.tracks.length}.</div>}
        </div>
      )}
    </section>
  )
}
