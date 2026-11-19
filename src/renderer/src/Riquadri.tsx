// Riordino a piacere delle schede e dei riquadri della regia (richiesta di cristian, 19/11/2026).
// Con "⇅ Riordina" acceso, ogni pagina mostra in cima l'elenco dei suoi riquadri con le frecce.
// I riquadri NON vengono spostati nel DOM (React non lo gradirebbe): si usa la proprietà CSS `order`
// del contenitore flex. Un riquadro si fa riordinabile con data-sezione="id" e data-titolo="Nome".
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { leggiOrdine, salvaOrdine, spostaSezione, unisciOrdine } from './ordine'

export const RiordinaContext = createContext(false)

/** Ordine salvato di una chiave, aggiornato quando cambia (anche da un'altra parte della regia). */
export function useOrdineSalvato(chiave: string): string[] | null {
  const [v, setV] = useState(() => leggiOrdine(chiave))
  useEffect(() => {
    setV(leggiOrdine(chiave))
    const f = (e: Event) => {
      if ((e as CustomEvent).detail === chiave) setV(leggiOrdine(chiave))
    }
    window.addEventListener('regia-ordine', f)
    return () => window.removeEventListener('regia-ordine', f)
  }, [chiave])
  return v
}

interface Voce {
  id: string
  titolo: string
}

function vociDi(el: HTMLElement): Voce[] {
  const out: Voce[] = []
  for (const c of Array.from(el.children) as HTMLElement[]) {
    const id = c.dataset.sezione
    if (id && !out.some((v) => v.id === id)) out.push({ id, titolo: c.dataset.titolo || id })
  }
  return out
}

const uguali = (a: Voce[], b: Voce[]) => a.length === b.length && a.every((v, i) => v.id === b[i].id && v.titolo === b[i].titolo)

/** Applica l'ordine con CSS: un figlio senza data-sezione resta attaccato a quello che lo precede. */
function applica(el: HTMLElement, ordine: string[]) {
  const rango = new Map(ordine.map((id, i) => [id, i + 1]))
  let ultimo = 0
  for (const c of Array.from(el.children) as HTMLElement[]) {
    const id = c.dataset.sezione
    const r = id ? (rango.get(id) ?? ultimo) : ultimo
    if (id) ultimo = r
    c.style.order = String(r)
  }
}

export function Riquadri({
  chiave,
  nome,
  className,
  as = 'div',
  children
}: {
  chiave: string
  /** Nome della pagina o colonna, mostrato sopra le frecce. */
  nome: string
  className?: string
  as?: 'div' | 'section'
  children: ReactNode
}) {
  const attivo = useContext(RiordinaContext)
  const salvato = useOrdineSalvato(chiave)
  const box = useRef<HTMLElement | null>(null)
  const [voci, setVoci] = useState<Voce[]>([])
  const ordine = unisciOrdine(
    voci.map((v) => v.id),
    salvato
  )

  const leggi = useCallback(() => {
    if (!box.current) return
    const nuove = vociDi(box.current)
    setVoci((prima) => (uguali(prima, nuove) ? prima : nuove))
  }, [])

  // dopo ogni render: i riquadri condizionali possono essere comparsi o spariti
  useLayoutEffect(() => {
    if (!box.current) return
    leggi()
    applica(box.current, ordine)
  })

  useEffect(() => {
    if (!box.current) return
    const obs = new MutationObserver(() => {
      leggi()
      if (box.current) applica(box.current, unisciOrdine(vociDi(box.current).map((v) => v.id), leggiOrdine(chiave)))
    })
    obs.observe(box.current, { childList: true })
    return () => obs.disconnect()
  }, [chiave, leggi])

  const visibili = voci.map((v) => v.id)
  const inOrdine = ordine.filter((id) => visibili.includes(id)).map((id) => voci.find((v) => v.id === id)!)
  const sposta = (id: string, verso: -1 | 1) => salvaOrdine(chiave, spostaSezione(ordine, visibili, id, verso))

  const Tag = as
  return (
    <Tag
      ref={(el: HTMLElement | null) => {
        box.current = el
      }}
      className={`${className ?? ''} ${attivo ? 'riordina-attivo' : ''}`}
    >
      {attivo && inOrdine.length > 1 && (
        <div className="riordina-barra">
          <span className="riordina-nome">Ordine dei riquadri · {nome}</span>
          {inOrdine.map((v, i) => (
            <span key={v.id} className="riordina-voce">
              <button className="small" disabled={i === 0} title="Sposta prima (più in alto)" onClick={() => sposta(v.id, -1)}>
                ▲
              </button>
              <span>{v.titolo}</span>
              <button
                className="small"
                disabled={i === inOrdine.length - 1}
                title="Sposta dopo (più in basso)"
                onClick={() => sposta(v.id, 1)}
              >
                ▼
              </button>
            </span>
          ))}
          {salvato && (
            <button className="small" onClick={() => salvaOrdine(chiave, null)} title="Torna all'ordine originale">
              Ripristina
            </button>
          )}
        </div>
      )}
      {children}
    </Tag>
  )
}
