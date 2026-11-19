import { useEffect, useState } from 'react'
import type { MbStatus } from '../../main/musicbrainz'
import type { TagStatus } from '../../main/tagServices'
import type { Track } from '../../core/types'

const api = window.radio

/** Completamento di autori, editore, ISWC, ISRC e generi con MusicBrainz, e musica ancora incompleta. */
export function MusicBrainzSection({ onEdit, refreshKey }: { onEdit: (t: Track) => void; refreshKey: string }) {
  const [st, setSt] = useState<MbStatus | null>(null)
  const [list, setList] = useState<{ tracks: Track[]; total: number } | null>(null)
  const [open, setOpen] = useState(false)

  const [tags, setTags] = useState<TagStatus[]>([])
  useEffect(() => api.onMbStatus(setSt), [])
  useEffect(
    () => api.onTagStatus((t) => setTags((prev) => (prev.some((x) => x.service === t.service) ? prev.map((x) => (x.service === t.service ? t : x)) : [...prev, t]))),
    []
  )
  useEffect(() => {
    void api.tagStatus().then(setTags)
  }, [refreshKey])
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
    <section className="panel mb-panel" data-sezione="musicbrainz" data-titolo="Dati dei brani (SIAE e generi)">
      <div className="section-title">Dati dei brani: report SIAE e generi</div>
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
      <ProblemBanner s={st} />
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
      {st.acoustId && (
        <p className="hint">AcoustID attivo: i brani non trovati per titolo vengono cercati anche dall'audio.</p>
      )}
      <div className="subsection">Altri servizi</div>
      {tags.map((t) => {
        const h = Math.ceil((t.todo * (t.service === 'dc' ? 1.1 : 0.3)) / 3600)
        return (
          <div key={t.service} className="tag-service">
            <b>{t.name}</b>{' '}
            {!t.configured
              ? 'manca la chiave: aggiungila in Impostazioni → Servizi per i dati dei brani.'
              : t.running
                ? `ricerca in corso: ${t.doneNow} controllati, ne restano ${t.todo}. Ora: ${t.current}`
                : t.todo > 0
                  ? `${t.todo} brani da cercare (circa ${h} ${h === 1 ? 'ora' : 'ore'}).`
                  : 'tutti i brani sono stati cercati.'}{' '}
            {t.checked > 0 && `Cercati ${t.checked}, con dati ${t.found}.`}
            <ProblemBanner s={t} />
            <div className="row">
              {t.running ? (
                <button className="small" onClick={() => void api.tagStop(t.service)}>
                  Ferma
                </button>
              ) : (
                <button className="small primary" disabled={!t.configured || !t.todo} onClick={() => void api.tagStart(t.service)}>
                  Cerca su {t.name}
                </button>
              )}
              <button
                className="small"
                disabled={t.running}
                title="Rimette in coda i brani già cercati senza risultato"
                onClick={async () => {
                  const n = await api.tagRetry(t.service)
                  setTags((prev) => prev.map((x) => (x.service === n.service ? n : x)))
                }}
              >
                Riprova i brani non trovati
              </button>
            </div>
          </div>
        )
      })}
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

/** Pausa dopo errori di fila (riprende da sola) oppure ricerca fermata. */
function ProblemBanner({ s }: { s: { running: boolean; lastError: string | null; pausedUntil: string | null } }) {
  if (!s.lastError) return null
  if (s.pausedUntil) {
    const at = new Date(s.pausedUntil).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    return (
      <div className="banner warn inline-banner">
        {s.lastError}: in pausa, riprovo da solo alle {at}.
      </div>
    )
  }
  if (s.running) return <div className="hint">Ultimo problema: {s.lastError} (sto riprovando)</div>
  return <div className="banner error inline-banner">Ricerca fermata: {s.lastError}</div>
}
