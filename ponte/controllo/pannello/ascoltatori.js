// Pannello remoto: ascoltatori adesso e statistiche (dagli Icecast principale e secondario).
'use strict'

const SVGNS = 'http://www.w3.org/2000/svg'
let statsKind = 'giorno'
let statsDate = isoDay(new Date())

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (text != null) e.textContent = text
  return e
}
const num = (n) => (Math.round(n * 10) / 10).toLocaleString('it-IT')
/** Massimo dell'asse: 4 righe con passo tondo (1, 2, 5 × 10^n). */
function niceMax(v) {
  const raw = Math.max(1, v / 4)
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw)
  return step * 4
}

// ---------- ascoltatori adesso, in alto ----------

async function loadListenersNow() {
  try {
    const r = await api(`/api/ascoltatori?periodo=giorno&data=${isoDay(new Date())}`)
    const n = r.now ? r.now.a + (r.now.b ?? 0) : null
    $('listeners-pill').hidden = n === null
    $('listeners-pill').textContent = `🎧 ${n}`
    return r
  } catch {
    return null
  }
}
$('listeners-pill').addEventListener('click', () => openStats())
setInterval(() => !$('app').hidden && loadListenersNow(), 60_000)
setTimeout(() => !$('app').hidden && loadListenersNow(), 1500)

// ---------- statistiche ----------

function openStats() {
  $('menu').hidden = true
  for (const id of ['main', 'users', 'progs', 'ann', 'imp', 'eventi']) $(id).hidden = true
  $('stats').hidden = false
  loadStats()
}
$('stats-btn').addEventListener('click', openStats)
$('stats-close').addEventListener('click', () => {
  $('stats').hidden = true
  $('main').hidden = false
})
for (const b of document.querySelectorAll('[data-periodo]')) {
  b.addEventListener('click', () => {
    statsKind = b.dataset.periodo
    loadStats()
  })
}
$('stats-date').addEventListener('change', (e) => {
  if (e.target.value) statsDate = e.target.value
  loadStats()
})
const shift = (dir) => {
  const d = new Date(`${statsDate}T12:00:00`)
  d.setDate(d.getDate() + dir * (statsKind === 'settimana' ? 7 : 1))
  statsDate = isoDay(d)
  loadStats()
}
$('stats-prev').addEventListener('click', () => shift(-1))
$('stats-next').addEventListener('click', () => shift(1))
setInterval(() => !$('stats').hidden && statsDate === isoDay(new Date()) && loadStats(), 60_000)

let statsSeq = 0
async function loadStats() {
  for (const b of document.querySelectorAll('[data-periodo]')) b.classList.toggle('on', b.dataset.periodo === statsKind)
  $('stats-date').value = statsDate
  // con il 4G le risposte possono arrivare in disordine: vale solo l'ultima richiesta
  const n = ++statsSeq
  try {
    const r = await api(`/api/ascoltatori?periodo=${encodeURIComponent(statsKind)}&data=${encodeURIComponent(statsDate)}`)
    if (n === statsSeq) drawStats(r)
  } catch (e) {
    if (n === statsSeq) notice(e.message)
  }
}

function tile(value, label) {
  const t = el('div', 'tile')
  t.append(el('div', 'v', value), el('div', 'l', label))
  return t
}

function drawStats(r) {
  const now = r.now ? r.now.a + (r.now.b ?? 0) : null
  const when = (t) =>
    new Date(t).toLocaleString('it-IT', r.periodo === 'settimana' ? { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
  $('stats-tiles').replaceChildren(
    tile(now === null ? '–' : String(now), 'adesso'),
    tile(String(r.peak), r.peakAt ? `picco (${when(r.peakAt)})` : 'picco'),
    tile(num(r.avg), 'media'),
    tile(num(r.hours), 'ore di ascolto')
  )
  const parts = []
  if (r.now) parts.push(`Adesso: ${r.now.a} sul principale${r.now.b === null ? '' : `, ${r.now.b} sul secondario`}.`)
  if (r.secondary && r.now && r.now.b === null) parts.push('L\'Icecast secondario non si riesce a leggere (vedi la guida).')
  if (!r.series.length) parts.push('Nessun dato in questo periodo.')
  $('stats-note').textContent = parts.join(' ')
  $('stats-chart-title').textContent = r.periodo === 'settimana' ? 'Andamento della settimana (media per ora)' : 'Andamento del giorno (media ogni 10 minuti)'
  lineChart($('stats-chart'), r)
  hourChart($('stats-hours'), r.byHour)
  $('stats-progs').replaceChildren(
    ...(r.byProgram.length
      ? r.byProgram.map((p) => {
          const tr = el('tr')
          tr.append(el('td', null, p.title), el('td', null, num(p.avg)), el('td', null, String(p.peak)), el('td', null, num(p.hours)))
          return tr
        })
      : [noPrograms()])
  )
}

function noPrograms() {
  const tr = el('tr')
  const td = el('td', 'hint', 'Nessun programma in onda in questo periodo.')
  td.colSpan = 4
  tr.append(td)
  return tr
}

/** Dettaglio al passaggio: [prima riga, valore in grassetto, resto], sempre come testo. */
function showTip(box, x, y, [head, bold, rest]) {
  let tip = box.querySelector('.tip')
  if (!tip) {
    tip = el('div', 'tip')
    box.append(tip)
  }
  tip.replaceChildren(document.createTextNode(head), el('b', null, bold), document.createTextNode(rest))
  tip.hidden = false
  const w = box.clientWidth
  tip.style.left = `${Math.min(Math.max(0, x + 12), w - tip.offsetWidth)}px`
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`
}
function hideTip(box) {
  const tip = box.querySelector('.tip')
  if (tip) tip.hidden = true
}

/** Linea con area: media del periodo, mirino e dettaglio al passaggio. */
function lineChart(box, r) {
  const W = 800, H = 240, L = 36, R = 10, T = 10, B = 24
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Ascoltatori nel periodo' })
  const max = niceMax(Math.max(1, ...r.series.map((p) => p.peak)))
  const x = (t) => L + ((t - r.from) / (r.to - r.from)) * (W - L - R)
  const y = (v) => T + (1 - v / max) * (H - T - B)
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i
    s.append(svg('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }), svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, num(v)))
  }
  const week = r.to - r.from > 2 * 86_400_000
  const tickStep = week ? 86_400_000 : 3 * 3600_000
  for (let t = r.from; t < r.to; t += tickStep) {
    const label = week ? new Date(t).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' }) : new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    s.append(svg('text', { x: x(t) + (week ? 4 : 0), y: H - 6, 'text-anchor': week ? 'start' : 'middle' }, label))
  }
  // segmenti separati dove mancano i dati (buchi più lunghi di un intervallo)
  const gap = r.step * 60_000 * 1.5
  let d = ''
  let area = ''
  let run = []
  const flush = () => {
    if (!run.length) return
    const pts = run.map((p) => `${x(p.t + (r.step * 60_000) / 2).toFixed(1)},${y(p.avg).toFixed(1)}`)
    d += `M${pts.join('L')}`
    area += `M${pts[0].split(',')[0]},${y(0)}L${pts.join('L')}L${pts.at(-1).split(',')[0]},${y(0)}Z`
    run = []
  }
  for (const p of r.series) {
    if (run.length && p.t - run.at(-1).t > gap) flush()
    run.push(p)
  }
  flush()
  s.append(svg('path', { class: 'area', d: area }), svg('path', { class: 'line', d }))
  const cross = svg('line', { class: 'cross', y1: T, y2: H - B, visibility: 'hidden' })
  const dot = svg('circle', { class: 'dot', r: 4, visibility: 'hidden' })
  s.append(cross, dot)
  const hit = svg('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' })
  s.append(hit)
  box.replaceChildren(s)
  const move = (ev) => {
    if (!r.series.length) return
    const rect = s.getBoundingClientRect()
    const vx = ((ev.clientX - rect.left) / rect.width) * W
    const t = r.from + ((vx - L) / (W - L - R)) * (r.to - r.from)
    const p = r.series.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
    const px = x(p.t + (r.step * 60_000) / 2)
    cross.setAttribute('x1', px)
    cross.setAttribute('x2', px)
    dot.setAttribute('cx', px)
    dot.setAttribute('cy', y(p.avg))
    cross.setAttribute('visibility', 'visible')
    dot.setAttribute('visibility', 'visible')
    const label = new Date(p.t).toLocaleString('it-IT', week ? { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
    showTip(box, (px / W) * rect.width, (y(p.avg) / H) * rect.height, [label, `${num(p.avg)} in media`, `picco ${p.peak} · principale ${num(p.a)}${p.b === null ? '' : ` · secondario ${num(p.b)}`}`])
  }
  hit.addEventListener('pointermove', move)
  hit.addEventListener('pointerdown', move)
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden')
    dot.setAttribute('visibility', 'hidden')
    hideTip(box)
  })
}

/** Barre per ora del giorno: media, con il picco nel dettaglio. */
function hourChart(box, hours) {
  const W = 800, H = 200, L = 36, R = 10, T = 10, B = 22
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Media degli ascoltatori per ora del giorno' })
  const max = niceMax(Math.max(1, ...hours.map((h) => h.avg)))
  const y = (v) => T + (1 - v / max) * (H - T - B)
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i
    s.append(svg('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }), svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, num(v)))
  }
  const bw = (W - L - R) / 24
  for (const h of hours) {
    const bx = L + h.hour * bw
    const top = y(h.avg)
    const height = Math.max(0, y(0) - top)
    // estremità arrotondata in alto, base piatta sull'asse
    const r = Math.min(4, height, (bw - 2) / 2)
    const w = bw - 2
    const path = height > 0
      ? `M${bx + 1},${y(0)}V${top + r}Q${bx + 1},${top} ${bx + 1 + r},${top}H${bx + 1 + w - r}Q${bx + 1 + w},${top} ${bx + 1 + w},${top + r}V${y(0)}Z`
      : ''
    const bar = svg('path', { class: 'bar', d: path })
    const hit = svg('rect', { x: bx, y: T, width: bw, height: H - T - B, fill: 'transparent' })
    hit.addEventListener('pointerenter', () => {
      bar.classList.add('dim')
      const rect = s.getBoundingClientRect()
      showTip(box, ((bx + bw / 2) / W) * rect.width, (top / H) * rect.height, [`dalle ${String(h.hour).padStart(2, '0')}:00`, `${num(h.avg)} in media`, `picco ${h.peak}`])
    })
    hit.addEventListener('pointerleave', () => {
      bar.classList.remove('dim')
      hideTip(box)
    })
    s.append(bar)
    if (h.hour % 3 === 0) s.append(svg('text', { x: bx + bw / 2, y: H - 6, 'text-anchor': 'middle' }, String(h.hour)))
    s.append(hit)
  }
  box.replaceChildren(s)
}
