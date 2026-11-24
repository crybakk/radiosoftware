// Pannello (/dashboard): impaginazione a mosaico sui PC larghi (richiesta di cristian, 23/11/2026).
// Da 900 px (due colonne; tre sopra i 1280 px) ogni riquadro occupa tante righe sottili quanto è alto,
// così i riquadri corti non lasciano buchi sotto di sé. L'ordine scelto con "⇅ Riordina" resta valido
// (la griglia usa la proprietà CSS `order`). Sui telefoni non fa niente: una colonna normale.
'use strict'

;(() => {
  const main = document.getElementById('main')
  if (!main || typeof ResizeObserver === 'undefined') return
  const largo = window.matchMedia('(min-width: 900px)')
  const RIGA = 4 // px, uguale a grid-auto-rows in pannello.css

  function sistema() {
    for (const c of main.children) {
      if (!largo.matches || c.hidden) {
        c.style.gridRowEnd = ''
        continue
      }
      // altezza del riquadro più lo spazio sotto (margin-bottom in pannello.css)
      const h = c.getBoundingClientRect().height + (parseFloat(getComputedStyle(c).marginBottom) || 0)
      const span = Math.max(1, Math.ceil(h / RIGA))
      if (c.style.gridRowEnd !== `span ${span}`) c.style.gridRowEnd = `span ${span}`
    }
  }

  let attesa = 0
  const presto = () => {
    if (!attesa) attesa = requestAnimationFrame(() => ((attesa = 0), sistema()))
  }
  const ro = new ResizeObserver(presto)
  const osserva = () => {
    for (const c of main.children) ro.observe(c)
  }
  osserva()
  // riquadri che compaiono o scompaiono (microfono, ospiti, diretta autonoma…)
  new MutationObserver(() => (osserva(), presto())).observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] })
  largo.addEventListener('change', presto)
  presto()
})()
