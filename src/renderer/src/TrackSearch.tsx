import { useEffect, useState, type ReactNode } from 'react'
import type { Track, TrackKind } from '../../core/types'
import { KIND_LABEL, mmss } from './format'

interface Filtri {
  title: string
  artist: string
  album: string
  genre: string
  yearFrom: string
  yearTo: string
  sort: 'artista' | 'titolo' | 'anno' | 'durata' | 'aggiunti'
}
const VUOTI: Filtri = { title: '', artist: '', album: '', genre: '', yearFrom: '', yearTo: '', sort: 'artista' }

/** Ricerca veloce nella libreria con azioni per ogni brano. */
export function TrackSearch({
  kind,
  actions,
  placeholder = 'Cerca titolo o artista…',
  limit = 100,
  autoFocus,
  refreshKey,
  category,
  onResult,
  filters,
  selected,
  onToggle,
  sezione
}: {
  kind?: TrackKind
  actions: (t: Track) => ReactNode
  /** Per il riordino dei riquadri (vedi Riquadri.tsx). */
  sezione?: { id: string; titolo: string }
  placeholder?: string
  limit?: number
  autoFocus?: boolean
  /** Cambia quando la libreria è stata aggiornata, per ricaricare i risultati. */
  refreshKey?: unknown
  /** Solo i brani di questa categoria. */
  category?: string
  /** I brani mostrati (per agire su tutti insieme). */
  onResult?: (r: { tracks: Track[]; total: number }) => void
  /** Mostra i filtri per titolo, artista, album, genere, anno e l'ordine. */
  filters?: boolean
  /** Selezione multipla: brani scelti e cambio di un brano. */
  selected?: Set<number>
  onToggle?: (t: Track) => void
}) {
  const [f, setF] = useState<Filtri>(VUOTI)
  const [showFilters, setShowFilters] = useState(false)
  const attivi = Object.entries(f).filter(([k, v]) => k !== 'sort' && v !== '').length
  const [text, setText] = useState('')
  const [kindFilter, setKindFilter] = useState<TrackKind | ''>(kind ?? '')
  const [result, setResult] = useState<{ tracks: Track[]; total: number }>({ tracks: [], total: 0 })
  // filtro per categoria o etichetta: solo se chi usa la ricerca non ne impone già una
  const showCatFilter = category === undefined && (kind === undefined || kind === 'music')
  const [catFilter, setCatFilter] = useState('')
  const [cats, setCats] = useState<{ name: string; count: number; mine: boolean }[]>([])
  const activeCategory = showCatFilter ? catFilter : category

  useEffect(() => {
    if (!showCatFilter) return
    let cancelled = false
    void window.radio.categories().then((c) => {
      if (!cancelled) setCats(c)
    })
    return () => {
      cancelled = true
    }
  }, [showCatFilter, refreshKey])

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      const r = await window.radio.search({
        text,
        kind: kindFilter || undefined,
        limit,
        category: activeCategory || undefined,
        title: f.title || undefined,
        artist: f.artist || undefined,
        album: f.album || undefined,
        genre: f.genre || undefined,
        yearFrom: f.yearFrom ? Number(f.yearFrom) : null,
        yearTo: f.yearTo ? Number(f.yearTo) : null,
        sort: f.sort
      })
      if (!cancelled) {
        setResult(r)
        onResult?.(r)
      }
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, kindFilter, limit, refreshKey, activeCategory, f])

  return (
    <div className="search" data-sezione={sezione?.id} data-titolo={sezione?.titolo}>
      <div className="search-bar">
        <input autoFocus={autoFocus} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
        {!kind && (
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as TrackKind | '')}>
            <option value="">Tutto</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        )}
        {showCatFilter && (
          <select
            className={catFilter ? 'on' : ''}
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            title="Mostra solo i brani di una categoria o di una tua etichetta"
          >
            <option value="">Tutte le categorie</option>
            {catFilter && !cats.some((c) => c.name === catFilter) && <option value={catFilter}>{catFilter}</option>}
            {cats.some((c) => c.mine) && (
              <optgroup label="★ Le tue etichette">
                {cats
                  .filter((c) => c.mine)
                  .map((c) => (
                    <option key={c.name} value={c.name}>
                      ★ {c.name} ({c.count})
                    </option>
                  ))}
              </optgroup>
            )}
            {cats.some((c) => !c.mine) && (
              <optgroup label="Categorie">
                {cats
                  .filter((c) => !c.mine)
                  .map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} ({c.count})
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
        )}
        {showCatFilter && catFilter && (
          <button className="small" onClick={() => setCatFilter('')} title="Togli il filtro categoria">
            ✕
          </button>
        )}
        {filters && (
          <button className={`small ${attivi ? 'on' : ''}`} onClick={() => setShowFilters(!showFilters)} title="Filtra per titolo, artista, album, genere, anno">
            Filtri{attivi ? ` (${attivi})` : ''} {showFilters ? '▴' : '▾'}
          </button>
        )}
      </div>
      {filters && showFilters && (
        <div className="search-filters">
          {(
            [
              ['title', 'Titolo'],
              ['artist', 'Artista'],
              ['album', 'Album'],
              ['genre', 'Genere o etichetta']
            ] as const
          ).map(([k, l]) => (
            <input key={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={l} aria-label={l} />
          ))}
          <input type="number" className="anno" value={f.yearFrom} onChange={(e) => setF({ ...f, yearFrom: e.target.value })} placeholder="Anno dal" aria-label="Anno dal" />
          <input type="number" className="anno" value={f.yearTo} onChange={(e) => setF({ ...f, yearTo: e.target.value })} placeholder="Anno al" aria-label="Anno al" />
          <select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value as Filtri['sort'] })} aria-label="Ordina per">
            <option value="artista">Ordina per artista</option>
            <option value="titolo">Ordina per titolo</option>
            <option value="anno">Più recenti per anno</option>
            <option value="durata">Più lunghi prima</option>
            <option value="aggiunti">Aggiunti di recente</option>
          </select>
          {attivi > 0 && (
            <button className="small" onClick={() => setF({ ...VUOTI, sort: f.sort })}>
              Togli i filtri
            </button>
          )}
        </div>
      )}
      <div className="search-count">
        {result.total > result.tracks.length ? `${result.tracks.length} di ${result.total}` : `${result.total} brani`}
      </div>
      <ul className="track-list">
        {result.tracks.map((t) => (
          <li key={t.id} className={selected?.has(t.id) ? 'selected' : ''}>
            {onToggle && (
              <input type="checkbox" checked={!!selected?.has(t.id)} onChange={() => onToggle(t)} aria-label={`Seleziona ${t.title}`} />
            )}
            <div className="t-main">
              <div className="t-title">{t.title}</div>
              <div className="t-artist">
                {t.artist}
                {t.kind !== 'music' && <span className="tag">{KIND_LABEL[t.kind]}</span>}
              </div>
            </div>
            <div className="t-dur">{mmss(t.duration)}</div>
            <div className="t-actions">{actions(t)}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
