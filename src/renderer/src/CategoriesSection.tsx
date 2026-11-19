import { useEffect, useMemo, useState } from 'react'

type Category = { name: string; count: number; mine: boolean }

/**
 * Le categorie della musica (generi dei file e dei servizi, etichette tue) con il numero di brani.
 * Toccandone una, l'elenco dei brani qui sotto mostra solo quella categoria.
 */
export function CategoriesSection({
  selected,
  onSelect,
  label,
  onLabel,
  refreshKey
}: {
  selected: string
  onSelect: (c: string) => void
  /** Etichetta da mettere ai brani (vuota = modalità etichettatura spenta). */
  label: string
  onLabel: (l: string) => void
  refreshKey: unknown
}) {
  const [cats, setCats] = useState<Category[]>([])
  const [filter, setFilter] = useState('')
  const [all, setAll] = useState(false)
  const [draft, setDraft] = useState(label)

  useEffect(() => {
    void window.radio.categories().then(setCats)
  }, [refreshKey])
  useEffect(() => setDraft(label), [label])

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = f ? cats.filter((c) => c.name.includes(f)) : cats
    return all || f ? list : list.slice(0, 60)
  }, [cats, filter, all])

  return (
    <section className="panel" data-sezione="categorie" data-titolo="Categorie">
      <div className="section-title">Categorie</div>
      <p className="hint">
        I generi dei file, quelli trovati da MusicBrainz, Discogs e Last.fm, e le <b>etichette tue</b> (★). Tocca una
        categoria per vedere i suoi brani. Le categorie valgono nelle regole di rotazione e nelle rotazioni con l'AI.
      </p>
      <div className="row">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Cerca una categoria…" />
        <span className="hint">{cats.length} categorie</span>
        {selected && (
          <button className="small" onClick={() => onSelect('')}>
            Mostra tutti i brani
          </button>
        )}
      </div>
      <div className="categories">
        {shown.map((c) => (
          <button
            key={c.name}
            className={`chip ${selected === c.name ? 'on' : ''} ${c.mine ? 'mine' : ''}`}
            title={c.mine ? 'Contiene brani con la tua etichetta' : undefined}
            onClick={() => onSelect(selected === c.name ? '' : c.name)}
          >
            {c.mine && '★ '}
            {c.name} <em>{c.count}</em>
          </button>
        ))}
        {!all && !filter && cats.length > shown.length && (
          <button className="chip ghost" onClick={() => setAll(true)}>
            altre {cats.length - shown.length}…
          </button>
        )}
        {!cats.length && <span className="hint">Ancora nessuna categoria: avvia le ricerche qui sopra o scrivi le tue etichette.</span>}
      </div>

      <div className="subsection">Etichetta i brani</div>
      <p className="hint">
        Scrivi un'etichetta tua (es. "estate", "da ballare", "mattina") e premi <b>Inizia</b>: nell'elenco dei brani
        compare il pulsante 🏷 per metterla o toglierla, e puoi metterla a tutti i brani mostrati insieme.
      </p>
      <div className="row">
        <input list="all-categories" value={draft} placeholder="nuova etichetta" maxLength={40} onChange={(e) => setDraft(e.target.value)} />
        <datalist id="all-categories">
          {cats.map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>
        {label ? (
          <button className="small" onClick={() => onLabel('')}>
            Fine
          </button>
        ) : (
          <button className="small primary" disabled={!draft.trim()} onClick={() => onLabel(draft.trim().toLowerCase())}>
            Inizia
          </button>
        )}
        {label && <span className="hint">Stai etichettando con «{label}»</span>}
      </div>
    </section>
  )
}
