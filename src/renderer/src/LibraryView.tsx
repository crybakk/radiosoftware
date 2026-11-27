import { useEffect, useState } from 'react'
import type { TrackEdit } from '../../core/db'
import { TRACK_KINDS, type LibraryFolder, type Track, type TrackKind } from '../../core/types'
import type { LibraryStatus } from '../../shared/api'
import { KIND_LABEL, mmss } from './format'
import { MusicBrainzSection } from './MusicBrainzSection'
import { CategoriesSection } from './CategoriesSection'
import { TrackSearch } from './TrackSearch'
import { PuliziaSection } from './PuliziaSection'
import type { Radio } from './useRadio'
import { Riquadri } from './Riquadri'
import { useConferma } from './Conferma'

export function LibraryView({ radio }: { radio: Radio }) {
  const avanzate = radio.settings.mostraAvanzate
  const conferma = useConferma()
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [status, setStatus] = useState<LibraryStatus | null>(null)
  const [newKind, setNewKind] = useState<TrackKind>('music')
  const [editing, setEditing] = useState<Track | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [category, setCategory] = useState('')
  const [label, setLabel] = useState('')
  const [shown, setShown] = useState<Track[]>([])
  const [labelMsg, setLabelMsg] = useState('')
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [selMsg, setSelMsg] = useState('')

  const togli = async (ids: number[], scarti: boolean): Promise<void> => {
    const ok = await conferma({
      titolo: ids.length === 1 ? 'Togliere questo brano dalla libreria?' : `Togliere ${ids.length} brani dalla libreria?`,
      testo: scarti
        ? 'Non andranno più in onda e i file vengono spostati nella cartella "_Tolti dalla libreria". Li ritrovi in Pulizia → Tolti dalla libreria.'
        : 'Non andranno più in onda. I file restano dove sono. Li ritrovi in Pulizia → Tolti dalla libreria.',
      si: 'Sì, togli'
    })
    if (!ok) return
    const r = scarti ? await window.radio.spostaNegliScarti(ids) : await window.radio.togliDallaLibreria(ids)
    setSelMsg(
      `${r.fatti} ${r.fatti === 1 ? 'brano tolto' : 'brani tolti'} dalla libreria${scarti ? ' e spostati in "_Tolti dalla libreria"' : ' (i file restano dove sono)'}. Li ritrovi in Pulizia → Tolti dalla libreria.` +
        (r.errori.length ? ` Problemi: ${r.errori.slice(0, 3).join('; ')}` : '')
    )
    setSel(new Set())
    setRefresh((x) => x + 1)
  }

  const tag = async (ids: number[], on: boolean): Promise<void> => {
    const n = await window.radio.setUserTag(ids, label, on)
    setLabelMsg(ids.length > 1 ? `«${label}» ${on ? 'messa' : 'tolta'} a ${n} brani.` : '')
    setRefresh((x) => x + 1)
  }

  useEffect(() => {
    void window.radio.listFolders().then(setFolders)
    void window.radio.libraryStatus().then(setStatus)
    return window.radio.onLibraryStatus(setStatus)
  }, [])

  const analyzed = status ? status.total - status.pendingAnalysis : 0
  // una sola barra per chi non vuole i dettagli: analisi del volume, impronte e Mix DJ insieme
  const lavoro = status ? status.total + status.fingerprintTotal + status.djTotal : 0
  const fatto = status ? analyzed + status.fingerprints + status.djDone : 0
  const preparazione = lavoro > 0 && fatto < lavoro ? Math.floor((fatto / lavoro) * 100) : null

  return (
    <Riquadri className="library-view" chiave="libreria" nome="Libreria">
      <section className="panel" data-sezione="cartelle" data-titolo="Cartelle della libreria">
        <div className="section-title">Cartelle della libreria</div>
        <p className="hint">
          Ogni cartella ha un tipo: la musica va in rotazione, i jingle si alternano alla musica e si possono mettere
          sui tasti istantanei.
        </p>
        <ul className="folder-list">
          {folders.map((f) => (
            <li key={f.id}>
              <span className="tag">{KIND_LABEL[f.kind]}</span>
              <span className="folder-path">{f.path}</span>
              <button
                className="small danger"
                onClick={async () => {
                  const ok = await conferma({
                    titolo: 'Togliere questa cartella dalla regia?',
                    testo: `${f.path}\n\nI suoi brani spariscono dalla libreria e non vanno più in onda. I file restano sul computer: non viene cancellato niente.`,
                    si: 'Sì, togli la cartella'
                  })
                  if (ok) setFolders(await window.radio.removeFolder(f.id))
                }}
              >
                Rimuovi
              </button>
            </li>
          ))}
          {folders.length === 0 && <li className="empty">Nessuna cartella: aggiungi quella della musica per iniziare.</li>}
        </ul>
        <div className="row">
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as TrackKind)}>
            {TRACK_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <button className="primary" onClick={async () => setFolders(await window.radio.chooseAndAddFolder(newKind))}>
            + Aggiungi cartella
          </button>
          <button
            className="primary"
            disabled={!folders.length || !!status?.scanning}
            onClick={() => void window.radio.scan()}
          >
            {status?.scanning ? 'Scansione in corso…' : 'Aggiorna libreria'}
          </button>
        </div>
        {status && (
          <div className="lib-status">
            <div>
              <b>{status.total}</b> brani ·{' '}
              {Object.entries(status.byKind)
                .map(([k, n]) => `${KIND_LABEL[k] ?? k}: ${n}`)
                .join(' · ')}
            </div>
            {!avanzate && preparazione !== null && (
              <div>
                La regia sta preparando i brani: {preparazione}% (puoi lavorare e andare in onda lo stesso)
                <div className="progress thin">
                  <div className="progress-fill" style={{ width: `${preparazione}%` }} />
                </div>
              </div>
            )}
            {avanzate && status.hiddenLong > 0 && (
              <div>
                {status.hiddenLong} brani più lunghi di {status.maxTrackMinutes} minuti (premixati) nascosti: non compaiono
                qui, nelle rotazioni e sul server. Il limite si cambia dal pannello del server (☰ → Impostazioni server →
                Radio).
              </div>
            )}
            {avanzate && status.hiddenShort > 0 && (
              <div>
                {status.hiddenShort} brani con meno di {durataLeggibile(status.minTrackSeconds)} di musica (intro, interludi):
                restano qui e li puoi mettere a mano, ma la regia e il server non li scelgono mai da soli. Il limite si cambia
                dal pannello del server (☰ → Impostazioni server → Radio).
              </div>
            )}
            {status.scanning && (
              <div>
                Scansione: {status.scanning.seen} file letti, {status.scanning.added} nuovi, {status.scanning.updated}{' '}
                aggiornati
              </div>
            )}
            {avanzate && status.total > 0 && (
              <div>
                Analisi volume e punti di mix: {analyzed} di {status.total}
                {status.analyzing ? ' (in corso, puoi continuare a lavorare)' : ''}
                <div className="progress thin">
                  <div className="progress-fill" style={{ width: `${(analyzed / Math.max(1, status.total)) * 100}%` }} />
                </div>
              </div>
            )}
            {avanzate && status.fingerprintTotal > 0 && (
              <div>
                Impronte audio per riconoscere i brani nelle esterne: {status.fingerprints} di {status.fingerprintTotal}
                {status.fingerprinting ? ' (in corso)' : ''}
                <div className="progress thin">
                  <div
                    className="progress-fill"
                    style={{ width: `${(status.fingerprints / Math.max(1, status.fingerprintTotal)) * 100}%` }}
                  />
                </div>
              </div>
            )}
            {avanzate && status.djTotal > 0 && (
              <div>
                Analisi per il Mix DJ (BPM, battiti, tonalità, energia, intro e outro): {status.djDone} di {status.djTotal}
                {status.djAnalyzing ? ' (in corso, qualche secondo a brano)' : ''}
                <div className="progress thin">
                  <div className="progress-fill" style={{ width: `${(status.djDone / Math.max(1, status.djTotal)) * 100}%` }} />
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {!avanzate && (
        <p className="hint" data-sezione="altri-strumenti" data-titolo="Altri strumenti">
          Altri strumenti (dati per la SIAE, pulizia dei brani, categorie): Impostazioni → Mostra le cose avanzate.
        </p>
      )}

      {avanzate && <MusicBrainzSection onEdit={setEditing} refreshKey={`${refresh}-${status?.total}-${status?.scanning ? 1 : 0}`} />}

      {avanzate && <PuliziaSection refreshKey={`${refresh}-${status?.total}-${status?.scanning ? 1 : 0}`} onChanged={() => setRefresh((x) => x + 1)} status={status} />}

      {avanzate && <CategoriesSection
        selected={category}
        onSelect={setCategory}
        label={label}
        onLabel={(l) => {
          setLabel(l)
          setLabelMsg('')
        }}
        refreshKey={`${refresh}-${status?.total}`}
      />}

      <section className="panel grow" data-sezione="brani" data-titolo="Brani">
        <div className="section-title">
          Brani
          {category && (
            <button className="small" onClick={() => setCategory('')} title="Mostra tutti i brani">
              Categoria: {category} ✕
            </button>
          )}
        </div>
        {label && (
          <div className="row label-bar">
            <span>
              🏷 Etichetta <b>«{label}»</b>:
            </span>
            <button className="small" disabled={!shown.length} onClick={() => void tag(shown.map((t) => t.id), true)}>
              Mettila a tutti i {shown.length} brani mostrati
            </button>
            <button className="small ghost" disabled={!shown.length} onClick={() => void tag(shown.map((t) => t.id), false)}>
              Toglila a tutti
            </button>
            {labelMsg && <span className="hint">{labelMsg}</span>}
          </div>
        )}
        <div className="row label-bar">
          <label className="check">
            <input
              type="checkbox"
              checked={shown.length > 0 && shown.every((t) => sel.has(t.id))}
              onChange={(e) => setSel(e.target.checked ? new Set([...sel, ...shown.map((t) => t.id)]) : new Set())}
            />
            <span>Seleziona tutti i {shown.length} mostrati</span>
          </label>
          {sel.size > 0 && (
            <>
              <span className="hint">{sel.size} selezionati</span>
              <button className="small danger" onClick={() => void togli([...sel], false)} title="Il file resta sul PC dov'è">
                Togli dalla libreria
              </button>
              <button
                className="small danger"
                onClick={() => void togli([...sel], true)}
                title='Il file va nella sottocartella "_Tolti dalla libreria" della sua cartella musica, per cancellarlo a mano quando vuoi'
              >
                Togli e sposta il file negli scarti
              </button>
              <button className="small ghost" onClick={() => setSel(new Set())}>
                Deseleziona
              </button>
            </>
          )}
          {selMsg && <span className="hint">{selMsg}</span>}
        </div>
        <TrackSearch
          filters
          selected={sel}
          onToggle={(t) => {
            const s = new Set(sel)
            if (s.has(t.id)) s.delete(t.id)
            else s.add(t.id)
            setSel(s)
          }}
          refreshKey={`${refresh}-${status?.total}-${status?.scanning ? 1 : 0}-${status?.analyzing ? 1 : 0}`}
          limit={300}
          category={category}
          onResult={(r) => setShown(r.tracks)}
          actions={(t) => {
            const has = !!label && t.userTags.split(',').map((x) => x.trim()).includes(label)
            return (
              <>
                {label && (
                  <button
                    className={`small ${has ? 'on' : ''}`}
                    title={has ? `Togli «${label}»` : `Metti «${label}»`}
                    onClick={() => void tag([t.id], !has)}
                  >
                    🏷 {has ? '✓' : '+'}
                  </button>
                )}
                <button className="small" onClick={() => setEditing(t)}>
                  Scheda
                </button>
              </>
            )
          }}
        />
      </section>

      {editing && (
        <TrackEditor
          track={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setRefresh((n) => n + 1)
          }}
        />
      )}
    </Riquadri>
  )
}

/** Campi sempre in vista nella scheda brano; gli altri sono in "Dati per la SIAE e dati tecnici". */
const BASE_FIELDS: (keyof TrackEdit)[] = ['title', 'artist', 'album', 'genre']

const TEXT_FIELDS: { key: keyof TrackEdit; label: string; hint?: string }[] = [
  { key: 'title', label: 'Titolo' },
  { key: 'artist', label: 'Interprete' },
  { key: 'album', label: 'Album' },
  { key: 'genre', label: 'Genere' },
  { key: 'composer', label: 'Autori / compositori', hint: 'Per il report SIAE' },
  { key: 'publisher', label: 'Editore', hint: 'Per il report SIAE' },
  { key: 'siaeCode', label: 'Codice opera SIAE' },
  { key: 'isrc', label: 'ISRC' },
  { key: 'iswc', label: 'ISWC' },
  { key: 'userTags', label: 'Etichette tue', hint: 'separate da virgole, per le rotazioni' }
]

export function TrackEditor({ track, onClose, onSaved }: { track: Track; onClose: () => void; onSaved: () => void }) {
  const [edit, setEdit] = useState<TrackEdit>({})
  const value = <K extends keyof TrackEdit>(k: K): TrackEdit[K] =>
    (k in edit ? edit[k] : (track as unknown as TrackEdit)[k]) as TrackEdit[K]

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body editor" onClick={(e) => e.stopPropagation()}>
        <div className="section-title">Scheda brano</div>
        <div className="file-path">{track.path}</div>
        {track.mbGenres && <div className="hint">Generi da MusicBrainz: {track.mbGenres}</div>}
        {track.dcGenres && <div className="hint">Generi da Discogs: {track.dcGenres}</div>}
        {track.lfmTags && <div className="hint">Etichette da Last.fm: {track.lfmTags}</div>}
        <div className="form-grid">
          {TEXT_FIELDS.filter((f) => BASE_FIELDS.includes(f.key)).map((f) => (
            <label key={f.key}>
              <span>
                {f.label}
                {f.hint && <em> · {f.hint}</em>}
              </span>
              <input
                value={String(value(f.key) ?? '')}
                onChange={(e) => setEdit({ ...edit, [f.key]: e.target.value })}
              />
            </label>
          ))}
          <label>
            <span>Anno</span>
            <input
              type="number"
              value={value('year') ?? ''}
              onChange={(e) => setEdit({ ...edit, year: e.target.value ? Number(e.target.value) : null })}
            />
          </label>
          <label>
            <span>Tipo</span>
            <select value={value('kind')} onChange={(e) => setEdit({ ...edit, kind: e.target.value as TrackKind })}>
              {TRACK_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <details className="tecniche">
          <summary className="section-title">Dati per la SIAE e dati tecnici</summary>
        <div className="form-grid">
          {TEXT_FIELDS.filter((f) => !BASE_FIELDS.includes(f.key)).map((f) => (
            <label key={f.key}>
              <span>
                {f.label}
                {f.hint && <em> · {f.hint}</em>}
              </span>
              <input value={String(value(f.key) ?? '')} onChange={(e) => setEdit({ ...edit, [f.key]: e.target.value })} />
            </label>
          ))}
          <label>
            <span>Inizio audio (s)</span>
            <input
              type="number"
              step="0.1"
              value={value('cueIn')}
              onChange={(e) => setEdit({ ...edit, cueIn: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>Punto di mix (s)</span>
            <input
              type="number"
              step="0.1"
              value={value('mixPoint')}
              onChange={(e) => setEdit({ ...edit, mixPoint: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>Fine audio (s)</span>
            <input
              type="number"
              step="0.1"
              value={value('cueOut')}
              onChange={(e) => setEdit({ ...edit, cueOut: Number(e.target.value) })}
            />
          </label>
        </div>
        </details>
        <div className="form-grid">
          <label className="check">
            <input
              type="checkbox"
              checked={!!value('enabled')}
              onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
            />
            <span>Può andare in onda (se lo togli, la canzone non viene più scelta né trovata)</span>
          </label>
        </div>
        <div className="info-line">
          Durata {mmss(track.duration)} · {track.bitrate ? `qualità ${track.bitrate} kbps` : 'qualità sconosciuta'} ·{' '}
          {track.loudness != null ? 'volume già livellato' : 'volume non ancora analizzato'}
        </div>
        <div className="info-line">{djLine(track)}</div>
        <div className="row end">
          <button onClick={onClose}>Annulla</button>
          <button
            className="primary"
            disabled={!Object.keys(edit).length}
            onClick={async () => {
              await window.radio.updateTrack(track.id, edit)
              onSaved()
            }}
          >
            Salva
          </button>
        </div>
      </div>
    </div>
  )
}

/** Riassunto dell'analisi "da DJ" di un brano, in parole semplici. */
function djLine(t: Track): string {
  const d = t.dj
  if (!d) return t.kind === 'music' ? 'Mix DJ: analisi non ancora fatta' : ''
  if (!(d.bpm > 0)) return `Mix DJ: ritmo non regolare, si usa la dissolvenza normale${d.energy ? ` · energia ${d.energy}/10` : ''}`
  const intro = Math.max(0, d.introEnd - d.firstDownbeat)
  const outro = Math.max(0, t.cueOut - d.outroStart)
  return [
    `${d.bpm.toFixed(1)} BPM`,
    d.key ? `tonalità ${d.key}` : '',
    d.energy ? `energia ${d.energy}/10` : '',
    `intro ${Math.round(intro)} s`,
    `outro ${Math.round(outro)} s`
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 120 → "2 minuti", 90 → "1 minuto e 30 secondi", 45 → "45 secondi". */
function durataLeggibile(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  const min = m === 1 ? '1 minuto' : `${m} minuti`
  if (!m) return `${s} secondi`
  return s ? `${min} e ${s} secondi` : min
}
