// Pagina pubblica delle puntate on demand: si ascoltano in streaming, senza scaricarle.
'use strict'
const $ = (id) => document.getElementById(id)
let api = ''
let current = null

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
const get = async (path) => {
  const r = await fetch(api + path)
  if (!r.ok) throw new Error(String(r.status))
  return r.json()
}
const date = (s) => new Date(s * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })

async function showList() {
  $('detail').hidden = true
  $('list').hidden = false
  const list = await get('/podcasts')
  const withEps = list.filter((p) => p.episodes > 0)
  $('empty').hidden = withEps.length > 0
  $('grid').replaceChildren(
    ...withEps.map((p) => {
      const a = el('a', 'prog')
      a.href = `#${p.id}`
      const img = el('img')
      img.alt = ''
      img.loading = 'lazy'
      if (p.has_custom_art) img.src = p.art
      const d = el('div')
      d.append(el('b', null, p.title), el('small', 'muted', `${p.episodes} ${p.episodes === 1 ? 'puntata' : 'puntate'}`))
      a.append(img, d)
      return a
    })
  )
}

async function showProgram(id, episodeId) {
  const [p, eps] = await Promise.all([get(`/podcast/${encodeURIComponent(id)}`), get(`/podcast/${encodeURIComponent(id)}/episodes`)])
  $('list').hidden = true
  $('detail').hidden = false
  $('d-title').textContent = p.title
  $('d-author').textContent = p.author
  $('d-desc').textContent = p.description
  $('d-art').hidden = !p.has_custom_art
  if (p.has_custom_art) $('d-art').src = p.art
  document.title = `${p.title} - puntate`
  $('eps').replaceChildren(
    ...eps.map((e) => {
      const li = el('li')
      li.dataset.id = e.id
      const play = el('button', 'play', '▶')
      play.setAttribute('aria-label', `Ascolta ${e.title}`)
      play.addEventListener('click', () => playEpisode(e, p))
      const t = el('div', 't')
      t.append(el('b', null, e.title), el('small', null, `${date(e.publish_at || e.created_at)} · ${e.media.length_text}`))
      if (e.description) t.append(el('p', null, e.description))
      li.append(play, t)
      return li
    })
  )
  if (!eps.length) $('eps').append(el('li', 'muted', 'Nessuna puntata.'))
  if (episodeId) {
    const e = eps.find((x) => x.id === episodeId)
    if (e) selectEpisode(e, p)
  }
  markCurrent()
}

function selectEpisode(e, p) {
  current = e.id
  $('player').hidden = false
  $('p-title').textContent = `${p.title}: ${e.title}`
  $('audio').src = e.links.download
  markCurrent()
}
function playEpisode(e, p) {
  if (current === e.id) {
    const a = $('audio')
    return a.paused ? void a.play() : a.pause()
  }
  selectEpisode(e, p)
  void $('audio').play()
  history.replaceState(null, '', `#${p.id}/${e.id}`)
}
function markCurrent() {
  for (const li of $('eps').children) li.classList.toggle('on', li.dataset.id === current)
}

// niente menu "salva audio con nome"
$('audio').addEventListener('contextmenu', (e) => e.preventDefault())

async function route() {
  try {
    // un indirizzo storpiato (per esempio "#%E0") non deve bloccare la pagina
    const [id, ep] = decodeURIComponent(location.hash.slice(1)).split('/')
    if (id) await showProgram(id, ep)
    else await showList()
  } catch {
    $('empty').hidden = false
    $('empty').textContent = 'Programma non trovato.'
    await showList().catch(() => {})
  }
}

;(async () => {
  try {
    const info = await (await fetch('/api/pubblico')).json()
    $('name').textContent = info.name
    api = `/api/station/${info.station}/public`
  } catch {
    $('empty').hidden = false
    $('empty').textContent = 'Il server non risponde: riprova tra poco.'
    return
  }
  window.addEventListener('hashchange', route)
  await route()
})()
