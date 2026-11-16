/**
 * Scheda Guida: la guida d'uso (docs/GUIDA.md) con gli screenshot, dentro la regia.
 * La guida e le immagini vengono incluse nel programma quando si crea l'installatore: funziona senza internet.
 */
import { useMemo, useRef, type MouseEvent } from 'react'
import guideMd from '../../../docs/GUIDA.md?raw'
import { renderMarkdown } from '../../../ponte/controllo/src/guidaMarkdown.ts'

const IMAGES = import.meta.glob<string>('../../../docs/immagini/*.{png,jpg}', { eager: true, query: '?url', import: 'default' })
const REPO = 'https://github.com/crybakk/radiosoftware/blob/main/docs/'

export function GuideView() {
  const box = useRef<HTMLDivElement>(null)
  const html = useMemo(
    () =>
      renderMarkdown(guideMd, {
        image: (src) => IMAGES[`../../../docs/${src}`] ?? src,
        link: (href) => new URL(href, REPO).toString()
      }),
    []
  )

  // i link "#…" scorrono dentro la scheda (la pagina della regia non cambia)
  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href') ?? ''
    if (!href.startsWith('#')) return
    e.preventDefault()
    box.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="guide-view" ref={box}>
      <button className="guide-top" onClick={() => box.current?.scrollTo({ top: 0, behavior: 'smooth' })} title="Torna all'inizio della guida">
        ↑ Indice
      </button>
      <article className="guida" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
