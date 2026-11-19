import { useEffect, useMemo, useState } from 'react'
import type { Track } from '../../core/types'
import type { EsitoPulizia } from '../../main/pulizia'
import { mmss } from './format'

const api = window.radio

type Vista = 'controllare' | 'doppioni' | 'tolti'

/**
 * Pulizia della libreria: brani che non sembrano radiofonici, doppioni e brani tolti.
 * Niente si toglie da solo: scegli tu (anche tanti insieme) e i file restano sul PC.
 */
export function PuliziaSection({ refreshKey, onChanged }: { refreshKey: string; onChanged: () => void }) {
  const [vista, setVista] = useState<Vista>('controllare')
  const [controllare, setControllare] = useState<{ tracks: (Track & { motivo: string })[]; total: number } | null>(null)
  const [doppioni, setDoppioni] = useState<{ gruppi: { tieni: number; tracks: Track[] }[]; total: number } | null>(null)
  const [tolti, setTolti] = useState<{ tracks: (Track & { origPath: string })[]; total: number } | null>(null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [n, setN] = useState(0)

  useEffect(() => {
    void api.daControllare().then(setControllare)
    void api.doppioni().then((d) => {
      setDoppioni(d)
    })
  }, [refreshKey, n])
  useEffect(() => {
    const t = setTimeout(() => void api.toltiDallaLibreria(q).then(setTolti), 150)
    return () => clearTimeout(t)
  }, [refreshKey, n, q])

  // cambiando vista si riparte da zero; nei doppioni sono già scelte le copie da togliere
  useEffect(() => {
    if (vista === 'doppioni' && doppioni) setSel(new Set(doppioni.gruppi.flatMap((g) => g.tracks.filter((t) => t.id !== g.tieni).map((t) => t.id))))
    else setSel(new Set())
    setMsg(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vista, doppioni])

  const visibili: number[] = useMemo(() => {
    if (vista === 'controllare') return controllare?.tracks.map((t) => t.id) ?? []
    if (vista === 'doppioni') return doppioni?.gruppi.flatMap((g) => g.tracks.map((t) => t.id)) ?? []
    return tolti?.tracks.map((t) => t.id) ?? []
  }, [vista, controllare, doppioni, tolti])

  const toggle = (id: number): void => {
    const s = new Set(sel)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setSel(s)
  }
  const tutti = visibili.length > 0 && visibili.every((id) => sel.has(id))

  const esegui = async (fn: () => Promise<EsitoPulizia | number>, cosa: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      const fatti = typeof r === 'number' ? r : r.fatti
      const errori = typeof r === 'number' ? [] : r.errori
      setMsg({
        kind: errori.length ? 'error' : 'ok',
        text: `${cosa}: ${fatti} ${fatti === 1 ? 'brano' : 'brani'}.` + (errori.length ? ` Problemi: ${errori.slice(0, 5).join('; ')}${errori.length > 5 ? ` e altri ${errori.length - 5}` : ''}` : '')
      })
      setSel(new Set())
      setN((x) => x + 1)
      onChanged()
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const ids = [...sel]

  const riga = (t: Track, extra: React.ReactNode, cls = ''): React.ReactNode => (
    <li key={t.id} className={cls}>
      <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Seleziona ${t.title}`} />
      <div className="t-main" onClick={() => toggle(t.id)}>
        <div className="t-title">{t.title || '(senza titolo)'}</div>
        <div className="t-artist">
          {t.artist}
          {extra}
        </div>
        <div className="hint file-path">{t.path}</div>
      </div>
      <div className="t-dur">
        {mmss(t.duration)}
        {t.bitrate ? <div className="hint">{t.bitrate} kbps</div> : null}
      </div>
    </li>
  )

  return (
    <section className="panel pulizia">
      <div className="section-title">Pulizia della libreria</div>
      <p className="hint">
        Qui trovi i brani che non sembrano adatti alla messa in onda (titoli tipo "Track 01", live@, nomi di file al posto
        del titolo, live e interviste) e i doppioni. Niente si toglie da solo: scegli tu. I file restano sul PC; se vuoi, li
        sposto nella sottocartella "_Tolti dalla libreria" della cartella musica, così li cancelli a mano quando vuoi.
      </p>
      <div className="row">
        <button className={vista === 'controllare' ? 'primary' : ''} onClick={() => setVista('controllare')}>
          Da controllare ({controllare?.total ?? '…'})
        </button>
        <button className={vista === 'doppioni' ? 'primary' : ''} onClick={() => setVista('doppioni')}>
          Doppioni ({doppioni?.total ?? '…'} gruppi)
        </button>
        <button className={vista === 'tolti' ? 'primary' : ''} onClick={() => setVista('tolti')}>
          Tolti dalla libreria ({tolti?.total ?? '…'})
        </button>
      </div>

      {vista === 'tolti' && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca tra i brani tolti" />}

      <div className="row label-bar">
        <label className="check">
          <input type="checkbox" checked={tutti} onChange={() => setSel(tutti ? new Set() : new Set(visibili))} />
          <span>{tutti ? 'Deseleziona tutti' : 'Seleziona tutti'}</span>
        </label>
        <span className="hint">{sel.size} selezionati</span>
        {vista !== 'tolti' ? (
          <>
            <button className="small danger" disabled={busy || !sel.size} onClick={() => void esegui(() => api.togliDallaLibreria(ids), 'Tolti dalla libreria')}>
              Togli dalla libreria
            </button>
            <button
              className="small danger"
              disabled={busy || !sel.size}
              onClick={() => void esegui(() => api.spostaNegliScarti(ids), 'Tolti e spostati in "_Tolti dalla libreria"')}
              title='Il file va nella sottocartella "_Tolti dalla libreria" della sua cartella musica: lo cancelli a mano quando vuoi'
            >
              Togli e sposta il file negli scarti
            </button>
            <button
              className="small"
              disabled={busy || !sel.size}
              onClick={() => void esegui(() => api.segnaRadiofonico(ids), 'Segnati come a posto')}
              title="Restano in libreria e non compaiono più qui"
            >
              Va bene così
            </button>
          </>
        ) : (
          <button className="small primary" disabled={busy || !sel.size} onClick={() => void esegui(() => api.rimettiInLibreria(ids), 'Rimessi in libreria')}>
            Rimetti in libreria
          </button>
        )}
      </div>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'} inline-banner`}>{msg.text}</div>}

      <ul className="track-list pulizia-list">
        {vista === 'controllare' &&
          (controllare?.tracks.length ? (
            controllare.tracks.map((t) => riga(t, <span className="tag">{t.motivo}</span>))
          ) : (
            <li className="hint">Nessun brano da controllare.</li>
          ))}
        {vista === 'controllare' && controllare && controllare.total > controllare.tracks.length && (
          <li className="hint">Mostrati i primi {controllare.tracks.length} di {controllare.total}: togline un po' e compaiono gli altri.</li>
        )}
        {vista === 'doppioni' &&
          (doppioni?.gruppi.length ? (
            doppioni.gruppi.map((g) => (
              <li key={`g${g.tieni}`} className="gruppo">
                <ul className="track-list">
                  {g.tracks.map((t) =>
                    riga(t, t.id === g.tieni ? <span className="tag ok">da tenere</span> : <span className="tag">copia</span>, t.id === g.tieni ? 'tieni' : '')
                  )}
                </ul>
              </li>
            ))
          ) : (
            <li className="hint">Nessun doppione.</li>
          ))}
        {vista === 'tolti' &&
          (tolti?.tracks.length ? (
            tolti.tracks.map((t) => riga(t, t.origPath ? <span className="tag">file negli scarti</span> : <span className="tag">file al suo posto</span>))
          ) : (
            <li className="hint">Nessun brano tolto.</li>
          ))}
      </ul>
      {vista === 'doppioni' && (
        <p className="hint">
          Per ogni gruppo ho già selezionato le copie da togliere e lasciato quella con la qualità migliore (poi quella già
          analizzata, poi la più lunga). Cambia la selezione se preferisci un'altra copia. "Va bene così" su un gruppo lo
          toglie da questa lista.
        </p>
      )}
    </section>
  )
}
