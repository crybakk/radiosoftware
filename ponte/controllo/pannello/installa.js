// Player pubblico installabile come app (richiesta di cristian, 27/11/2026).
// - Android, Chrome ed Edge sul computer: il pulsante "Installa l'app" apre la finestra del browser per installare.
// - iPhone e iPad (e Safari sul Mac): non esiste una finestra automatica, quindi il pulsante mostra i passi da fare.
// - Se la radio è già aperta come app, o il browser non sa installare (es. Firefox), non si vede niente.
// Il riquadro sotto il player si può chiudere ("No, grazie") e non ricompare; resta il piccolo pulsante in alto.
'use strict'
;(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
  }

  const giaApp = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true
  if (giaApp()) return

  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  // browser dentro le app (Facebook, Instagram, WhatsApp…): da lì non si installa, serve Safari/Chrome
  const dentroApp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|Telegram/i.test(ua)
  const safariMac = !ios && /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua)

  const header = document.querySelector('header')
  const main = document.querySelector('main')
  if (!header || !main) return

  let richiesta = null // finestra di installazione del browser (Android, Chrome, Edge)
  const chiuso = () => localStorage.getItem('installa-chiuso') === '1'

  const btn = document.createElement('button')
  btn.className = 'installa-btn'
  btn.type = 'button'
  btn.textContent = "📲 Installa l'app"
  btn.hidden = true
  header.append(btn)

  const card = document.createElement('section')
  card.className = 'installa-card'
  card.hidden = true
  card.innerHTML = `<div class="installa-testo"><b>Vuoi la radio tra le tue app?</b>
    <span class="muted">Un'icona sul telefono o sul computer: un tocco e ascolti.</span></div>
    <div class="installa-azioni"><button type="button" class="play installa-si">Installa</button>
    <button type="button" class="installa-no">No, grazie</button></div>
    <ol class="installa-passi" hidden></ol>`
  main.append(card)
  const passi = card.querySelector('.installa-passi')

  function mostra() {
    btn.hidden = false
    card.hidden = chiuso()
  }

  function nascondi() {
    btn.hidden = true
    card.hidden = true
  }

  function istruzioni() {
    let righe
    if (dentroApp) {
      righe = [
        'Questa pagina è aperta dentro un\'altra app (Facebook, Instagram, WhatsApp…).',
        ios ? 'Tocca i tre puntini e scegli <b>Apri in Safari</b>.' : 'Tocca i tre puntini e scegli <b>Apri nel browser</b>.',
        'Poi premi di nuovo <b>Installa l\'app</b>.'
      ]
    } else if (ios) {
      righe = [
        'Tocca il pulsante <b>Condividi</b>: il quadrato con la freccia verso l\'alto <span aria-hidden="true">⬆️</span> (in basso su iPhone, in alto su iPad).',
        'Scorri e scegli <b>Aggiungi alla schermata Home</b>.',
        'Tocca <b>Aggiungi</b>. L\'icona della radio comparirà tra le tue app.'
      ]
    } else {
      righe = ['Nel menu <b>File</b> in alto scegli <b>Aggiungi al Dock</b>.', 'Premi <b>Aggiungi</b>. La radio comparirà nel Dock e nel Launchpad.']
    }
    passi.innerHTML = righe.map((r) => `<li>${r}</li>`).join('')
    passi.hidden = false
    card.hidden = false
    card.querySelector('.installa-azioni').hidden = true
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function installa() {
    if (richiesta) {
      const r = richiesta
      richiesta = null
      r.prompt()
      const scelta = await r.userChoice.catch(() => null)
      // se non installa, il pulsante torna quando il browser lo permette di nuovo
      if (scelta?.outcome !== 'accepted') nascondi()
      return
    }
    istruzioni()
  }

  btn.addEventListener('click', installa)
  card.querySelector('.installa-si').addEventListener('click', installa)
  card.querySelector('.installa-no').addEventListener('click', () => {
    localStorage.setItem('installa-chiuso', '1')
    card.hidden = true
  })

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    richiesta = e
    mostra()
  })
  window.addEventListener('appinstalled', () => {
    nascondi()
    const fatto = document.createElement('p')
    fatto.className = 'installa-fatto'
    fatto.textContent = 'Fatto! Trovi la radio tra le tue app.'
    main.append(fatto)
    setTimeout(() => fatto.remove(), 8000)
  })

  // iPhone, iPad, Safari sul Mac e browser dentro le app: niente finestra automatica, si mostrano i passi
  if (ios || safariMac || dentroApp) mostra()
})()
