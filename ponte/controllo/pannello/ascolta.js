// Pagina pubblica: ascolto della radio in diretta con il titolo in onda.
'use strict'
const $ = (id) => document.getElementById(id)
let info = null

async function refresh() {
  try {
    info = await (await fetch('/api/pubblico')).json()
    $('name').textContent = info.name
    document.title = `${info.name} - in diretta`
    const np = info.nowPlaying
    $('title').textContent = np?.title || info.name
    $('artist').textContent = np?.artist || ''
    if (!info.listenUrl) $('msg').textContent = 'Indirizzo d\'ascolto non configurato sul server.'
  } catch {
    // riprova al prossimo giro
  }
}

$('play').addEventListener('click', () => {
  const a = $('audio')
  if (!a.paused) {
    a.pause()
    a.removeAttribute('src')
    a.load()
    $('play').textContent = '▶'
    return
  }
  if (!info?.listenUrl) return
  // ogni volta un indirizzo nuovo: si riparte dalla diretta, non da quello che il browser ha in memoria
  a.src = `${info.listenUrl}${info.listenUrl.includes('?') ? '&' : '?'}t=${Date.now()}`
  a.play().then(
    () => ($('play').textContent = '■'),
    () => ($('msg').textContent = 'Il browser non riesce a far partire l\'audio.')
  )
})

refresh()
setInterval(refresh, 15_000)
