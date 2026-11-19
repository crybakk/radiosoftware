// Benvenuto al primo accesso nel pannello (richiesta di cristian, 19/11/2026): poche schede adatte al ruolo,
// con Avanti e Salta. Si mostra da solo una volta per utente (lo ricorda il server) e si rivede dal menu ☰.
'use strict'

let welcomeSteps = []
let welcomeAt = 0

function welcomeContent(user, station) {
  const boss = user.role === 'amministratore'
  const cmd = user.role === 'amministratore' || user.role === 'conduttore'
  const ruolo = boss
    ? 'Sei <b>amministratore</b>: comandi la regia e gestisci utenti, programmi e impostazioni.'
    : cmd
      ? 'Sei <b>conduttore</b>: puoi comandare la regia, parlare in onda e far entrare gli ospiti.'
      : 'Sei <b>ospite</b>: vedi cosa va in onda e cerchi nella libreria, ma non comandi la regia.'
  const steps = [
    { icon: '👋', title: `Ciao ${user.name}, eccoti in ${station}!`, text: `Questo è il pannello della radio: funziona da telefono, tablet e computer.<br><br>${ruolo}` },
    {
      icon: '📻',
      title: 'Cosa va in onda',
      text: 'In alto la spia diventa rossa quando un brano è <b>in onda</b>. <b>REGIA</b> verde vuol dire che il PC dello studio è collegato.<br><br>Sotto vedi titolo, artista e il tempo che manca.'
    }
  ]
  if (cmd) {
    steps.push({
      icon: '🎧',
      title: 'Comandare la regia',
      text: '<b>▶ PLAY</b>, <b>⏭ AVANTI</b> e <b>■ STOP</b> comandano la regia dello studio. In <b>Cerca nella libreria</b> trovi un brano: <b>⤒</b> lo mette come prossimo, <b>+</b> in fondo alla coda.<br><br>Con <b>🎙 Apri microfono</b> parli in onda da qui; da <b>Ospiti</b> crei un link per far parlare qualcuno in diretta.'
    })
  } else {
    steps.push({
      icon: '🔎',
      title: 'Cercare i brani',
      text: 'In <b>Cerca nella libreria</b> trovi i brani della radio. Se ti serve comandare la regia, chiedi a un amministratore di cambiarti il ruolo.'
    })
  }
  if (boss) {
    steps.push({
      icon: '⚙️',
      title: 'Il menu ☰',
      text: 'Dal menu <b>☰</b> in alto a destra apri <b>Programmi</b>, <b>Ascoltatori</b>, <b>Annunci vocali</b>, <b>Utenti</b> (anche per invitare qualcuno con un link) e <b>Impostazioni server</b>.'
    })
  } else {
    steps.push({ icon: '☰', title: 'Il menu ☰', text: 'Dal menu <b>☰</b> in alto a destra apri <b>Programmi</b> e <b>Ascoltatori</b>, e da lì esci dal pannello.' })
  }
  steps.push({
    icon: '📖',
    title: 'Se hai un dubbio',
    text: 'Nel menu <b>☰</b> trovi la <b>📖 Guida</b>, con le immagini, e <b>👋 Benvenuto</b> per rivedere queste schede.<br><br>Buona radio!'
  })
  return steps
}

function drawWelcome() {
  const s = welcomeSteps[welcomeAt]
  $('wel-icon').textContent = s.icon
  $('wel-title').textContent = s.title
  // testi scritti qui sopra: solo il nome dell'utente e della radio vengono da fuori, e si puliscono
  $('wel-text').innerHTML = s.text
  const dots = $('wel-dots')
  dots.replaceChildren(...welcomeSteps.map((_, i) => el('span', i === welcomeAt ? 'on' : '')))
  $('wel-back').hidden = welcomeAt === 0
  const last = welcomeAt === welcomeSteps.length - 1
  $('wel-next').textContent = last ? 'Inizia' : 'Avanti →'
  $('wel-skip').hidden = last
}

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function openWelcome(user, station) {
  welcomeSteps = welcomeContent({ ...user, name: escapeHtml(user.name) }, station)
  // il titolo si scrive come testo: lì il nome va senza &amp;
  welcomeSteps[0].title = `Ciao ${user.name}, eccoti in ${station}!`
  welcomeAt = 0
  $('menu').hidden = true
  $('welcome').hidden = false
  drawWelcome()
  $('wel-next').focus()
}

function closeWelcome() {
  $('welcome').hidden = true
  api('/api/io/benvenuto', { method: 'POST' }).catch(() => {})
}

$('wel-next').addEventListener('click', () => {
  if (welcomeAt === welcomeSteps.length - 1) return closeWelcome()
  welcomeAt++
  drawWelcome()
})
$('wel-back').addEventListener('click', () => {
  if (welcomeAt > 0) welcomeAt--
  drawWelcome()
})
$('wel-skip').addEventListener('click', closeWelcome)
document.addEventListener('keydown', (e) => {
  if ($('welcome').hidden) return
  if (e.key === 'Escape') closeWelcome()
  else if (e.key === 'ArrowRight') $('wel-next').click()
  else if (e.key === 'ArrowLeft' && welcomeAt > 0) $('wel-back').click()
})

let welcomeStation = 'Radio'
$('welcome-btn').addEventListener('click', () => openWelcome(me, welcomeStation))

/** All'apertura del pannello: il benvenuto si mostra da solo solo al primo accesso. */
async function checkWelcome() {
  try {
    const r = await api('/api/io')
    if (r.station) welcomeStation = r.station
    if (r.benvenuto && me) openWelcome(me, welcomeStation)
  } catch {
    // niente benvenuto: il pannello funziona lo stesso
  }
}
