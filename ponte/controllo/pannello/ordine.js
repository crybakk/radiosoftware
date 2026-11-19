// Pannello (/dashboard): riquadri della panoramica e voci del menu nell'ordine che preferisci
// (richiesta di cristian, 19/11/2026). Menu → "⇅ Riordina": compaiono le frecce, l'ordine resta salvato
// in questo browser. Gli elementi non si spostano nel DOM: si usa la proprietà CSS `order`.
// Un elemento si fa riordinabile con data-sezione="id" e data-titolo="Nome".
// Lo stesso algoritmo è in src/renderer/src/ordine.ts (regia); provato in tests/ordine.test.ts.
'use strict'

/** Ordine salvato + elementi di adesso: i salvati restano tutti, un nuovo va dopo quello che lo precede. */
function unisciOrdine(predefinito, salvato) {
  const out = []
  for (const id of Array.isArray(salvato) ? salvato : []) if (typeof id === 'string' && !out.includes(id)) out.push(id)
  predefinito.forEach((id, i) => {
    if (out.includes(id)) return
    let pos = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(predefinito[j])
      if (k >= 0) {
        pos = k + 1
        break
      }
    }
    out.splice(pos, 0, id)
  })
  return out
}

/** Un posto prima (-1) o dopo (+1), saltando gli elementi che ora non si vedono. */
function spostaSezione(ordine, visibili, id, verso) {
  const vis = ordine.filter((x) => visibili.includes(x))
  const i = vis.indexOf(id)
  const altro = vis[i + verso]
  if (i < 0 || altro === undefined) return [...ordine]
  const out = [...ordine]
  out[out.indexOf(id)] = altro
  out[out.indexOf(altro)] = id
  return out
}

if (typeof module !== 'undefined') module.exports = { unisciOrdine, spostaSezione }

if (typeof document !== 'undefined' && document.getElementById('main')) {
  const PREFISSO = 'pannello.ordine.'
  const leggi = (chiave) => {
    try {
      const v = JSON.parse(localStorage.getItem(PREFISSO + chiave) || 'null')
      return Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }
  const salva = (chiave, v) => {
    try {
      if (v) localStorage.setItem(PREFISSO + chiave, JSON.stringify(v))
      else localStorage.removeItem(PREFISSO + chiave)
    } catch {}
  }

  let attivo = false
  const gruppi = []

  function gruppo(box, chiave, nome, frecce) {
    const barra = document.createElement('div')
    barra.className = 'riordina-barra'
    barra.hidden = true
    box.prepend(barra)
    const g = { box, chiave, nome, frecce, barra }
    gruppi.push(g)
    new MutationObserver(() => aggiorna(g)).observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
    aggiorna(g)
  }

  const figli = (g) => Array.from(g.box.children).filter((c) => c.dataset.sezione)

  function aggiorna(g) {
    const tutti = figli(g)
    const ordine = unisciOrdine(tutti.map((c) => c.dataset.sezione), leggi(g.chiave))
    const rango = new Map(ordine.map((id, i) => [id, i + 1]))
    let ultimo = 0
    for (const c of g.box.children) {
      const id = c.dataset.sezione
      const r = id ? rango.get(id) : ultimo
      if (id) ultimo = r
      if (c.style.order !== String(r)) c.style.order = String(r)
    }
    g.box.classList.toggle('riordina-attivo', attivo)
    if (g.barra.hidden !== !attivo) g.barra.hidden = !attivo
    if (!attivo) return
    const vis = tutti.filter((c) => !c.hidden)
    const visibili = vis.map((c) => c.dataset.sezione)
    const inOrdine = ordine.filter((id) => visibili.includes(id))
    const firma = JSON.stringify([inOrdine, !!leggi(g.chiave)])
    if (g.barra.dataset.firma === firma) return
    g.barra.dataset.firma = firma
    const nodi = [Object.assign(document.createElement('b'), { textContent: `Ordine · ${g.nome}` })]
    inOrdine.forEach((id, i) => {
      const el = vis.find((c) => c.dataset.sezione === id)
      const voce = document.createElement('span')
      voce.className = 'riordina-voce'
      const freccia = (testo, verso, titolo, disabled) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'small', textContent: testo, title: titolo, disabled })
        b.addEventListener('click', () => {
          salva(g.chiave, spostaSezione(ordine, visibili, id, verso))
          aggiorna(g)
        })
        return b
      }
      voce.append(
        freccia(g.frecce[0], -1, 'Sposta prima', i === 0),
        Object.assign(document.createElement('span'), { textContent: el.dataset.titolo || id }),
        freccia(g.frecce[1], 1, 'Sposta dopo', i === inOrdine.length - 1)
      )
      nodi.push(voce)
    })
    if (leggi(g.chiave)) {
      const r = Object.assign(document.createElement('button'), { type: 'button', className: 'small ghost', textContent: 'Ripristina', title: "Torna all'ordine originale" })
      r.addEventListener('click', () => {
        salva(g.chiave, null)
        aggiorna(g)
      })
      nodi.push(r)
    }
    const fine = Object.assign(document.createElement('button'), { type: 'button', className: 'small primary', textContent: '✓ Fatto' })
    fine.addEventListener('click', () => imposta(false))
    nodi.push(fine)
    g.barra.replaceChildren(...nodi)
  }

  function imposta(v) {
    attivo = v
    for (const g of gruppi) {
      g.barra.dataset.firma = ''
      aggiorna(g)
    }
    $('riordina-btn').textContent = v ? '✓ Fatto' : '⇅ Riordina'
    if (v) {
      $('menu').hidden = false
      window.scrollTo(0, 0)
    }
  }

  gruppo($('main'), 'panoramica', 'riquadri della panoramica', ['▲', '▼'])
  gruppo($('menu'), 'menu', 'voci del menu', ['◀', '▶'])
  $('riordina-btn').addEventListener('click', () => imposta(!attivo))
}
