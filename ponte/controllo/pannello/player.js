// Player pubblico (pagina principale del server): diretta, titolo in onda, brani recenti, come la pagina
// pubblica di AzuraCast. Legge /api/nowplaying, la stessa API che usa l'app della radio.
'use strict'
const $ = (id) => document.getElementById(id)
let info = null
let playing = false

const time = (s) => new Date(s * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function setArt(img, url) {
  if (url && img.getAttribute('src') !== url) img.src = url
  img.hidden = !url
}

async function refresh() {
  try {
    const r = await fetch('/api/nowplaying', { cache: 'no-store' })
    if (!r.ok) throw new Error(String(r.status))
    const data = (await r.json())[0]
    info = data
    const st = data.station
    $('name').textContent = st.name
    document.title = `${st.name} - in diretta`
    $('desc').textContent = st.description || ''
    $('desc').hidden = !st.description
    const np = data.now_playing
    const song = np?.song
    $('title').textContent = song?.title || st.name
    $('artist').textContent = song?.artist || ''
    $('onair').textContent = data.live?.is_live ? `IN DIRETTA · ${data.live.streamer_name}` : 'IN DIRETTA'
    setArt($('art'), song?.art || '')
    $('noart').hidden = !!song?.art
    // barra del brano solo se si conosce la durata
    const dur = np?.duration || 0
    $('bar').hidden = !dur
    if (dur) $('bar-fill').style.width = `${Math.min(100, (100 * np.elapsed) / dur)}%`
    $('msg').textContent = st.listen_url ? (data.is_online === false ? 'La radio in questo momento non trasmette.' : '') : 'Indirizzo d\'ascolto non configurato sul server.'
    for (const k of ['m3u', 'pls']) {
      $(k).href = st[`playlist_${k}_url`] || '#'
      $(k).hidden = !st.listen_url || !st[`playlist_${k}_url`]
    }
    drawHistory(data.song_history || [])
    mediaSession(song, st.name)
  } catch {
    // riprova al prossimo giro
  }
}

function drawHistory(list) {
  $('history-box').hidden = !list.length
  $('history').replaceChildren(
    ...list.slice(0, 10).map((h) => {
      const li = el('li')
      const img = el('img')
      img.alt = ''
      img.loading = 'lazy'
      setArt(img, h.song.art)
      const t = el('div', 't')
      t.append(el('b', null, h.song.title), el('small', 'muted', h.song.artist || ''))
      li.append(img, t, el('span', 'muted when', time(h.played_at)))
      return li
    })
  )
}

/** Titolo e copertina anche nella schermata di blocco del telefono. */
function mediaSession(song, name) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song?.title || name,
    artist: song?.artist || '',
    album: name,
    artwork: song?.art ? [{ src: song.art, sizes: '512x512' }] : []
  })
}

function stop() {
  const a = $('audio')
  a.pause()
  a.removeAttribute('src')
  a.load()
  playing = false
  $('play').textContent = '▶'
  $('play').setAttribute('aria-label', 'Ascolta')
}

function start() {
  const url = info?.station?.listen_url
  if (!url) return
  const a = $('audio')
  // ogni volta un indirizzo nuovo: si riparte dalla diretta, non da quello che il browser ha in memoria
  a.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
  a.play().then(
    () => {
      playing = true
      $('play').textContent = '■'
      $('play').setAttribute('aria-label', 'Ferma')
      $('msg').textContent = ''
    },
    () => ($('msg').textContent = 'Il browser non riesce a far partire l\'audio.')
  )
}

$('play').addEventListener('click', () => (playing ? stop() : start()))

const vol = $('volume')
const saved = Number(localStorage.getItem('volume'))
if (localStorage.getItem('volume') !== null && saved >= 0 && saved <= 1) vol.value = String(saved)
$('audio').volume = Number(vol.value)
vol.addEventListener('input', () => {
  $('audio').volume = Number(vol.value)
  localStorage.setItem('volume', vol.value)
})

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler?.('play', start)
  navigator.mediaSession.setActionHandler?.('pause', stop)
  navigator.mediaSession.setActionHandler?.('stop', stop)
}

refresh()
setInterval(refresh, 15_000)
