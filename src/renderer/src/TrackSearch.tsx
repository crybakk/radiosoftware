import { useEffect, useState, type ReactNode } from 'react'
import type { Track, TrackKind } from '../../core/types'
import { KIND_LABEL, mmss } from './format'

/** Ricerca veloce nella libreria con azioni per ogni brano. */
export function TrackSearch({
  kind,
  actions,
  placeholder = 'Cerca titolo o artista…',
  limit = 100,
  autoFocus,
  refreshKey,
  category,
  onResult
}: {
  kind?: TrackKind
  actions: (t: Track) => ReactNode
  placeholder?: string
  limit?: number
  autoFocus?: boolean
  /** Cambia quando la libreria è stata aggiornata, per ricaricare i risultati. */
  refreshKey?: unknown
  /** Solo i brani di questa categoria. */
  category?: string
  /** I brani mostrati (per agire su tutti insieme). */
  onResult?: (r: { tracks: Track[]; total: number }) => void
}) {
  const [text, setText] = useState('')
  const [kindFilter, setKindFilter] = useState<TrackKind | ''>(kind ?? '')
  const [result, setResult] = useState<{ tracks: Track[]; total: number }>({ tracks: [], total: 0 })

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      const r = await window.radio.search({ text, kind: kindFilter || undefined, limit, category: category || undefined })
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
  }, [text, kindFilter, limit, refreshKey, category])

  return (
    <div className="search">
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
      </div>
      <div className="search-count">
        {result.total > result.tracks.length ? `${result.tracks.length} di ${result.total}` : `${result.total} brani`}
      </div>
      <ul className="track-list">
        {result.tracks.map((t) => (
          <li key={t.id}>
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
