// Player pubblico (pagina principale del server): diretta, titolo e copertina in onda, come la pagina
// pubblica di AzuraCast. Legge /api/nowplaying, la stessa API che usa l'app della radio; le copertine
// le cerca il server (copertine.ts), altrimenti si vede quella del programma o il logo.
'use strict'
const $ = (id) => document.getElementById(id)
let info = null
let playing = false

function setArt(img, url) {
  if (url && img.getAttribute('src') !== url) img.src = url
  img.hidden = !url
}

// L'HLS arriva in ritardo rispetto alla diretta (scelta di cristian, 17/11/2026): mentre si ascolta in HLS
// titolo e copertina cambiano dopo gli stessi secondi (impostazione del server, di base 30); con l'MP3 subito.
let viaHls = false
let storico = []
let ritardoHls = 30

async function leggiRitardo() {
  try {
    const r = await fetch('/api/player', { cache: 'no-store' })
    const n = Number((await r.json()).hls_ritardo_titoli)
    if (r.ok && Number.isFinite(n) && n >= 0) ritardoHls = n
  } catch {
    // server vecchio: resta il valore di base
  }
}

function ritardoTitoli() {
  return viaHls ? ritardoHls * 1000 : 0
}

async function refresh() {
  try {
    const r = await fetch('/api/nowplaying', { cache: 'no-store' })
    if (!r.ok) throw new Error(String(r.status))
    info = (await r.json())[0]
    const ora = Date.now()
    storico.push({ t: ora, data: info })
    // si tengono le letture degli ultimi minuti: bastano per qualsiasi ritardo
    storico = storico.filter((x) => ora - x.t < 180_000)
  } catch {
    // riprova al prossimo giro
  }
  draw()
}

/** Mostra la lettura di "ritardo" secondi fa (la più vecchia disponibile, se ascolta da meno). */
function draw() {
  if (!info) return
  const limite = Date.now() - ritardoTitoli()
  const vista = [...storico].reverse().find((x) => x.t <= limite)?.data ?? storico[0]?.data ?? info
  const st = info.station
  $('name').textContent = st.name
  document.title = `${st.name} - in diretta`
  $('desc').textContent = st.description || ''
  $('desc').hidden = !st.description
  const song = vista.now_playing?.song
  $('title').textContent = song?.title || st.name
  $('artist').textContent = song?.artist || ''
  $('onair').textContent = vista.live?.is_live ? `IN DIRETTA · ${vista.live.streamer_name}` : 'IN DIRETTA'
  setArt($('art'), song?.art || '')
  $('noart').hidden = !!song?.art
  if (!$('play').classList.contains('loading')) {
    $('msg').textContent = st.listen_url || st.hls_url ? (info.is_online === false ? 'La radio in questo momento non trasmette.' : '') : 'Indirizzo d\'ascolto non configurato sul server.'
  }
  mediaSession(song, st.name)
}

/** Titolo e copertina anche nella schermata di blocco del telefono. */
let ultimoMedia = ''
function mediaSession(song, name) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
  // solo quando cambia: la schermata di blocco non deve ridisegnarsi ogni secondo
  const chiave = `${song?.title}|${song?.artist}|${song?.art}|${name}`
  if (chiave === ultimoMedia) return
  ultimoMedia = chiave
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song?.title || name,
    artist: song?.artist || '',
    album: name,
    artwork: song?.art ? [{ src: song.art, sizes: '512x512' }] : []
  })
}

// ---------- ascolto: HLS (scelta di cristian, 17/11/2026) con l'MP3 di Icecast come riserva ----------
// Safari e i telefoni leggono l'HLS da soli; gli altri browser con hls.js (caricato solo al primo play).
// Mentre l'audio carica, o si ferma per la rete, il pulsante mostra che sta caricando.
let hls = null
let tentativo = 0
let attesa = null

function setButton(state) {
  const b = $('play')
  b.classList.toggle('loading', state === 'loading')
  b.textContent = state === 'stopped' ? '▶' : state === 'playing' ? '■' : ''
  b.setAttribute('aria-label', state === 'stopped' ? 'Ascolta' : state === 'playing' ? 'Ferma' : 'Sto caricando, premi per fermare')
  b.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false')
  if (state === 'loading') $('msg').textContent = 'Sto caricando…'
  else if ($('msg').textContent === 'Sto caricando…') $('msg').textContent = ''
}

function cleanup() {
  clearTimeout(attesa)
  if (hls) {
    hls.destroy()
    hls = null
  }
  const a = $('audio')
  a.pause()
  a.removeAttribute('src')
  a.load()
}

function stop() {
  tentativo++
  cleanup()
  playing = false
  viaHls = false
  setButton('stopped')
}

let hlsJs = null
function loadHlsJs() {
  if (window.Hls) return Promise.resolve(window.Hls)
  hlsJs ??= new Promise((ok, ko) => {
    const s = document.createElement('script')
    s.src = '/hls.light.min.js'
    s.onload = () => (window.Hls ? ok(window.Hls) : ko(new Error('hls.js')))
    s.onerror = () => {
      hlsJs = null
      ko(new Error('hls.js'))
    }
    document.head.append(s)
  })
  return hlsJs
}

/** Ogni volta un indirizzo nuovo: si riparte dalla diretta, non da quello che il browser ha in memoria. */
const fresh = (url) => `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`

function startMp3(mio) {
  const url = info?.station?.listen_url
  if (!url) return fail()
  cleanup()
  playing = false
  viaHls = false
  setButton('loading')
  const a = $('audio')
  a.src = fresh(url)
  play(mio, false)
}

async function startHls(mio, url) {
  viaHls = true
  const a = $('audio')
  if (a.canPlayType('application/vnd.apple.mpegurl')) {
    a.src = url
    return play(mio, true)
  }
  let Hls
  try {
    Hls = await loadHlsJs()
  } catch {
    Hls = null
  }
  if (mio !== tentativo) return
  if (!Hls || !Hls.isSupported()) return startMp3(mio)
  // niente worker: la pagina non permette script da blob:
  hls = new Hls({ enableWorker: false, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6 })
  hls.on(Hls.Events.ERROR, (_e, d) => {
    if (!d.fatal || mio !== tentativo) return
    // HLS non disponibile (server vecchio, rete che lo blocca…): si passa all'MP3
    if (!playing || d.type !== Hls.ErrorTypes.NETWORK_ERROR) return startMp3(mio)
    hls.startLoad()
  })
  hls.loadSource(url)
  hls.attachMedia(a)
  play(mio, true)
}

// ogni passaggio (HLS, poi MP3) ha il suo numero: le risposte di un passaggio già superato non contano
let passi = 0
function play(mio, isHls) {
  const a = $('audio')
  const passo = ++passi
  clearTimeout(attesa)
  // se dopo 15 secondi non suona ancora: dall'HLS si passa all'MP3, dall'MP3 si avvisa
  attesa = setTimeout(() => {
    if (mio !== tentativo || passo !== passi || playing) return
    if (isHls) startMp3(mio)
    else fail()
  }, 15_000)
  a.play().catch((e) => {
    if (mio !== tentativo || passo !== passi) return
    if (e?.name === 'NotAllowedError') return fail('Il browser non lascia partire l\'audio: premi di nuovo ▶.')
    if (isHls) startMp3(mio)
    else fail()
  })
}

function fail(text = 'Il browser non riesce a far partire l\'audio.') {
  tentativo++
  cleanup()
  playing = false
  viaHls = false
  setButton('stopped')
  $('msg').textContent = text
}

function start() {
  const st = info?.station
  if (!st?.listen_url && !st?.hls_url) return
  const mio = ++tentativo
  cleanup()
  playing = false
  $('msg').textContent = ''
  setButton('loading')
  if (st.hls_enabled && st.hls_url) startHls(mio, fresh(st.hls_url))
  else startMp3(mio)
}

const audio = $('audio')
audio.addEventListener('playing', () => {
  if (!audio.src && !hls) return
  clearTimeout(attesa)
  playing = true
  setButton('playing')
})
// la rete rallenta: si fa vedere che sta caricando, finché riprende da solo
audio.addEventListener('waiting', () => {
  if (tentativo && (playing || $('play').classList.contains('loading'))) setButton('loading')
})

// copertina che non si carica: si mostra la nota al suo posto
$('art').addEventListener('error', () => {
  $('art').hidden = true
  $('noart').hidden = false
})

$('play').addEventListener('click', () => (playing || $('play').classList.contains('loading') ? stop() : start()))

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

leggiRitardo()
setInterval(leggiRitardo, 300_000)
refresh()
// ogni 5 secondi: il ritardo dei titoli in HLS resta preciso
setInterval(refresh, 5_000)
setInterval(draw, 1_000)
