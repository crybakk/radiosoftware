// Pannello (/dashboard): ritorno alla panoramica da ogni sezione (richiesta di cristian, 16/11/2026).
// Il pulsante "← Panoramica" in alto compare quando una sezione copre la panoramica; anche il tasto
// "indietro" del telefono o del browser torna alla panoramica invece di uscire dal pannello.
'use strict'

const NAV_SECTIONS = ['progs', 'stats', 'ann', 'users', 'imp']

// pagina ricaricata mentre era aperta una sezione: si riparte dalla panoramica, senza passi in cronologia
if (history.state?.sezione || location.hash) history.replaceState(null, '', location.pathname)

/** Sezione aperta al posto della panoramica (null se si vede la panoramica). */
const openSection = () => NAV_SECTIONS.find((id) => !$(id).hidden) ?? null

function goHome() {
  $('menu').hidden = true
  const id = openSection()
  // il pulsante di chiusura della sezione fa anche la sua pulizia (aggiornamenti, ascolti in corso)
  if (id) $(`${id}-close`).click()
  else $('main').hidden = false
  window.scrollTo(0, 0)
}

$('home-btn').addEventListener('click', goHome)

function syncNav() {
  const away = !$('app').hidden && $('main').hidden
  $('home-btn').hidden = !away
  if (away && !history.state?.sezione) {
    history.pushState({ sezione: true }, '', `#${openSection() ?? ''}`)
    window.scrollTo(0, 0)
  } else if (!away && history.state?.sezione) {
    // tornati alla panoramica con un pulsante: si toglie il passo aggiunto alla cronologia
    history.back()
  }
}

window.addEventListener('popstate', () => {
  if (!$('main').hidden || $('app').hidden) return
  goHome()
})

new MutationObserver(syncNav).observe($('main'), { attributes: true, attributeFilter: ['hidden'] })
new MutationObserver(syncNav).observe($('app'), { attributes: true, attributeFilter: ['hidden'] })
