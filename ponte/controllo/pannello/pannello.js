// Pannello remoto di Radio Regia: niente librerie, funziona da telefono, tablet e computer.
'use strict'

const $ = (id) => document.getElementById(id)
const KIND = { music: 'Musica', jingle: 'Jingle', news: 'Notiziario', program: 'Programma', spot: 'Spot' }

let me = null
let ws = null
let state = null
let stateAt = 0
let studio = false
let seq = 0
const waiting = new Map()
let retry = 1

function mmss(s) {
  if (!Number.isFinite(s) || s < 0) s = 0
  s = Math.floor(s)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function hhmm(iso) {
  return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
}
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
function button(text, title, onClick, cls) {
  const b = el('button', cls, text)
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
function notice(text) {
  const n = $('notice')
  n.textContent = text
  n.hidden = !text
  if (text) setTimeout(() => { if (n.textContent === text) n.hidden = true }, 5000)
}
const canCommand = () => me && (me.role === 'amministratore' || me.role === 'conduttore')

// ---------- accesso ----------

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(body.error || `errore ${r.status}`), { status: r.status })
  return body
}

async function start() {
  try {
    me = (await api('/api/io')).user
    showApp()
  } catch {
    showLogin()
  }
}

function showLogin() {
  me = null
  if (ws) ws.close()
  $('app').hidden = true
  $('login').hidden = false
  $('login-name').focus()
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('login-error').hidden = true
  try {
    me = (await api('/api/login', { method: 'POST', body: JSON.stringify({ name: $('login-name').value, password: $('login-password').value }) })).user
    $('login-password').value = ''
    showApp()
  } catch (err) {
    $('login-error').textContent = err.message
    $('login-error').hidden = false
  }
})

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {})
  showLogin()
})
$('menu-btn').addEventListener('click', () => ($('menu').hidden = !$('menu').hidden))

function showApp() {
  $('login').hidden = true
  $('app').hidden = false
  showRole()
  connect()
  loadUnknowns()
  loadSpokenTitle()
  // benvenuto.js si carica dopo: al primo avvio la funzione c'è già quando arriva la risposta di /api/io
  setTimeout(() => typeof checkWelcome === 'function' && checkWelcome(), 0)
}

/** Pulsanti e sezioni secondo il ruolo (anche quando l'amministratore lo cambia a pannello aperto). */
function showRole() {
  $('who').textContent = `${me.name} · ${me.role}`
  $('users-btn').hidden = me.role !== 'amministratore'
  $('ann-btn').hidden = me.role !== 'amministratore'
  $('imp-btn').hidden = me.role !== 'amministratore'
  if (me.role !== 'amministratore' && (!$('users').hidden || !$('ann').hidden || !$('imp').hidden)) {
    $('users').hidden = true
    $('ann').hidden = true
    $('imp').hidden = true
    $('main').hidden = false
  }
  $('readonly').hidden = canCommand()
}

// ---------- canale in tempo reale ----------

function connect() {
  if (ws && ws.readyState <= 1) return
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/pannello`)
  ws = sock
  sock.onopen = () => (retry = 1)
  sock.onmessage = (e) => {
    // messaggi di un canale vecchio (per esempio dopo esci e rientra) non toccano quello nuovo
    if (ws !== sock) return
    let m
    try {
      m = JSON.parse(e.data)
    } catch {
      return
    }
    if (m.t === 'hello') {
      // il ruolo può essere cambiato mentre il pannello era aperto: vale quello del server
      if (m.user && me) {
        me = { ...me, ...m.user }
        showRole()
        renderVideo()
        loadUnknowns()
      }
      studio = m.studio
      if (m.state) setState(m.state)
      render()
      // la libreria della regia si vede subito (se la regia è collegata), senza dover cercare
      if (studio && !libBrowsed) {
        libBrowsed = true
        $('search-form').requestSubmit()
      }
    } else if (m.t === 'state') {
      setState(m.state)
    } else if (m.t === 'studio') {
      studio = m.connected
      render()
      if (studio && !libBrowsed) {
        libBrowsed = true
        $('search-form').requestSubmit()
      }
    } else if (m.t === 'alarms') {
      $('alarms').hidden = !m.alarms.length
      $('alarms').textContent = m.alarms.map((a) => `⚠ ${a.message}`).join('  ·  ')
    } else if (m.t === 'ospiti') {
      guestList = m.guests
      renderGuests()
    } else if (m.t === 'video') {
      video = m.video
      renderVideo()
    } else if (m.t === 'autonoma') {
      auto = m.state
      renderAuto()
      if (!auto?.active) autoBrowsed = false
      // la libreria del server si vede solo in diretta autonoma, già piena senza dover cercare
      if (!autoBrowsed && auto?.active && !$('auto-card').hidden) {
        autoBrowsed = true
        $('auto-search-form').requestSubmit()
      }
    } else if (m.t === 'esterna') {
      renderEsterna(m.esterna)
    } else if (m.t === 'mic') {
      mic = m.mic
      renderMic()
    } else if (m.t === 'reply') {
      const w = waiting.get(m.id)
      if (w) {
        waiting.delete(m.id)
        m.ok ? w.resolve(m.data) : w.reject(new Error(m.error || 'errore'))
      }
    }
  }
  sock.onclose = (e) => {
    if (ws !== sock) return
    // senza canale il ponte chiude il microfono: lo chiudiamo anche qui
    if (pc) micShutdown('Connessione al ponte persa: microfono chiuso')
    for (const w of waiting.values()) w.reject(new Error('connessione persa'))
    waiting.clear()
    studio = false
    render()
    if (!me) return
    if (e.code === 4003 || e.code === 1008) return showLogin()
    // senza sessione valida il server rifiuta subito: controlliamo prima di riprovare
    setTimeout(() => {
      if (ws !== sock || !me) return
      api('/api/io').then(
        (r) => {
          if (r.user && me) {
            me = r.user
            showRole()
          }
          connect()
        },
        (err) => (err.status === 401 ? showLogin() : connect())
      )
    }, retry * 1000)
    retry = Math.min(retry * 2, 15)
  }
}

function request(msg) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('non collegato al ponte'))
    const id = `p${++seq}`
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ ...msg, id }))
  })
}
const send = (cmd) => request({ t: 'cmd', cmd })
const command = (cmd) => send(cmd).catch((e) => notice(e.message))

function setState(s) {
  state = s
  stateAt = Date.now()
  render()
}

// ---------- disegno ----------

function render() {
  const st = $('studio')
  st.textContent = studio ? 'REGIA OK' : 'REGIA SCOLLEGATA'
  st.className = `pill ${studio ? 'ok' : 'off'}`
  const ctl = studio && canCommand()
  for (const b of document.querySelectorAll('[data-cmd]')) b.disabled = !ctl
  const mode = $('mode')
  mode.disabled = !ctl || !state
  if (state) {
    mode.textContent = state.mode === 'auto' ? 'AUTOMATICO' : 'MANUALE'
    mode.className = `mode ${state.mode === 'auto' ? 'auto' : 'manual'}`
  }
  renderNow()
  renderQueue(ctl)
  renderCarts(ctl)
  renderMic()
  renderAuto()
  renderGuests()
  if (state?.lastError) notice(state.lastError)
}

function renderNow() {
  const cur = state?.onAir
  $('lamp').textContent = cur ? 'IN ONDA' : 'FERMO'
  $('lamp').className = `lamp ${cur ? 'lit' : ''}`
  if (!cur || !studio) {
    $('now-kind').textContent = ''
    $('now-title').textContent = studio ? 'Nessun brano in onda' : 'Regia non collegata al ponte'
    $('now-artist').textContent = ''
    $('now-pos').textContent = ''
    $('now-rem').textContent = ''
    $('now-progress').style.width = '0'
    $('now').classList.remove('ending')
    $('now-intro').hidden = true
    return
  }
  const passed = (Date.now() - stateAt) / 1000
  const pos = cur.position + passed
  const rem = Math.max(0, cur.remaining - passed)
  $('now-kind').textContent = (KIND[cur.kind] || '') + (cur.eventLabel ? ` · ${cur.eventLabel}` : '')
  $('now-title').textContent = cur.title
  $('now-artist').textContent = cur.artist
  $('now-pos').textContent = mmss(pos)
  $('now-rem').textContent = `-${mmss(rem)}`
  $('now-progress').style.width = `${Math.min(100, (pos / Math.max(1, pos + rem)) * 100)}%`
  $('now').classList.toggle('ending', rem <= 10)
  // conto alla rovescia dell'intro: quanto manca alla voce
  const intro = cur.introLeft == null ? -1 : cur.introLeft - passed
  $('now-intro').hidden = intro <= 0
  if (intro > 0) {
    $('now-intro').textContent = `🎙 Intro ${Math.ceil(intro)} s`
    $('now-intro').classList.toggle('last', intro <= 3)
  }
}

function trackRow(t, left) {
  const li = el('li', t.origin === 'event' ? 'event' : '')
  if (left) li.append(el('span', 't-eta', left))
  const main = el('div', 't-main')
  const title = el('div', 't-title', t.title)
  if (t.eventLabel) title.append(el('span', 'tag', t.eventLabel))
  if (t.intro > 0) title.append(el('span', 'tag intro', `intro ${Math.round(t.intro)} s`))
  main.append(title, el('div', 't-artist', t.artist || KIND[t.kind] || ''))
  li.append(main, el('span', 't-dur', mmss(t.duration)))
  return li
}

function renderQueue(ctl) {
  const ul = $('queue')
  ul.replaceChildren()
  const q = state?.queue ?? []
  if (!q.length) ul.append(el('li', 'hint', state?.mode === 'auto' ? 'La coda si riempie da sola…' : 'Coda vuota'))
  q.forEach((t, i) => {
    const li = trackRow(t, hhmm(t.eta))
    if (ctl) {
      const a = el('div', 't-actions')
      a.append(
        button('▲', 'Su', () => command({ type: 'move', uid: t.uid, delta: -1 }), i === 0 ? 'small' : 'small'),
        button('▼', 'Giù', () => command({ type: 'move', uid: t.uid, delta: 1 }), 'small'),
        button('✕', 'Togli dalla coda', () => command({ type: 'remove', uid: t.uid }), 'small')
      )
      li.append(a)
    }
    ul.append(li)
  })
}

function renderCarts(ctl) {
  const box = $('carts')
  box.replaceChildren()
  for (const c of state?.carts ?? []) {
    const b = el('button', `cart ${c.name ? '' : 'empty'} ${c.playing ? 'playing' : ''}`)
    b.append(el('small', null, String(c.n)), document.createTextNode(c.name || 'vuoto'))
    b.disabled = !ctl || !c.name
    b.addEventListener('click', () => command({ type: 'cart', n: c.n }))
    box.append(b)
  }
}

// ---------- comandi ----------

for (const b of document.querySelectorAll('[data-cmd]')) {
  b.addEventListener('click', () => command({ type: b.dataset.cmd }))
}
$('mode').addEventListener('click', () => command({ type: 'mode', mode: state?.mode === 'auto' ? 'manual' : 'auto' }))

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const q = $('search-q').value.trim()
  const ul = $('results')
  ul.replaceChildren(el('li', 'hint', 'Ricerca…'))
  try {
    const tracks = await send({ type: 'search', q })
    ul.replaceChildren()
    if (!tracks.length) ul.append(el('li', 'hint', 'Nessun brano trovato'))
    for (const t of tracks) {
      const li = trackRow(t)
      if (canCommand()) {
        const a = el('div', 't-actions')
        a.append(
          button('⤒', 'Metti come prossimo', () => command({ type: 'enqueue', trackId: t.id, where: 'next' }).then(() => notice(`"${t.title}" è il prossimo`)), 'small'),
          button('+', 'Aggiungi in fondo alla coda', () => command({ type: 'enqueue', trackId: t.id, where: 'end' }).then(() => notice(`"${t.title}" aggiunto in coda`)), 'small')
        )
        li.append(a)
      }
      ul.append(li)
    }
  } catch (err) {
    ul.replaceChildren(el('li', 'error', err.message))
  }
})

// ---------- microfono remoto ----------

let mic = { user: null, onAir: false }
let pc = null
let micMix = null // { stream, mic: [{ gain, an }], tot, ctx, stop } da microfoni.js
let micBusy = false

// Due microfoni (23/11/2026): scelte ricordate in questo browser
const MIC_KEY = 'radio-microfoni'
function micDefault() {
  return [
    { device: '', channel: 'tutti', vol: 1, muted: false },
    { device: null, channel: 'tutti', vol: 1, muted: false }
  ]
}
let micSet = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(MIC_KEY))
    if (Array.isArray(v) && v.length === 2) return v.map((m, i) => ({ ...micDefault()[i], ...m }))
  } catch {}
  return micDefault()
})()
if (micSet[0].device === null) micSet[0].device = ''
const micSave = () => { try { localStorage.setItem(MIC_KEY, JSON.stringify(micSet)) } catch {} }
let micInputs = []
let micInputsNamed = false

function micChEls(i) {
  const box = document.querySelector(`.mic-ch[data-mic="${i}"]`)
  return { box, dev: box.querySelector('.mic-dev'), chan: box.querySelector('.mic-chan'), vol: box.querySelector('.mic-vol'), mute: box.querySelector('.mic-mute'), level: box.querySelector('.mic-ch-level') }
}

function renderMicChannels() {
  const open = !!pc
  for (const i of [0, 1]) {
    const e = micChEls(i)
    const m = micSet[i]
    const opts = []
    if (i === 1) opts.push(['__none', '— nessuno (un solo microfono) —'])
    opts.push(['', 'Predefinito del dispositivo'])
    for (const d of micInputs) opts.push([d.deviceId, d.label])
    // un ingresso scelto ma non più collegato resta visibile, così non si perde la scelta
    if (m.device && !micInputs.some((d) => d.deviceId === m.device)) opts.push([m.device, 'Ingresso non trovato (scollegato?)'])
    e.dev.replaceChildren(...opts.map(([v, t]) => { const o = el('option', null, t); o.value = v; return o }))
    e.dev.value = m.device === null ? '__none' : m.device
    e.chan.replaceChildren(...Object.entries(CANALI_MIC).map(([v, t]) => { const o = el('option', null, t); o.value = v; return o }))
    e.chan.value = m.channel
    const off = m.device === null
    e.box.classList.toggle('off', off)
    // durante la diretta si cambiano solo volume e muto; per cambiare ingresso si chiude e riapre
    e.dev.disabled = open || micBusy
    e.chan.disabled = open || micBusy || off
    e.chan.hidden = off
    e.vol.disabled = off
    e.vol.value = String(m.vol)
    e.mute.hidden = off
    e.mute.classList.toggle('muted', !!m.muted)
    e.mute.textContent = m.muted ? '🔇 Muto' : '🎙 Attivo'
    e.level.parentElement.hidden = off || !open
  }
}

async function micLoadInputs(ask) {
  if (!window.isSecureContext || !navigator.mediaDevices) return
  try {
    micInputs = await elencoIngressi(ask)
    micInputsNamed = micInputs.every((d) => !/^Ingresso \d+$/.test(d.label))
  } catch {}
  renderMicChannels()
}

function renderMic() {
  const card = $('mic-card')
  card.hidden = !me || !canCommand()
  if (card.hidden) return
  const mine = !!pc
  const who = $('mic-who')
  who.textContent = mic.user ? `${mic.user}${mic.onAir ? ' · IN ONDA' : ' · fuori onda'}` : ''
  who.className = `mic-who ${mic.onAir ? 'onair' : ''}`
  // qualità della linea del microfono (verde/giallo/rosso), misurata dal ponte
  const linea = mine ? lineaEl(mic.linea) : null
  $('mic-linea').replaceChildren(...(linea ? [linea] : []))
  $('mic-linea').hidden = !linea
  const secure = window.isSecureContext && navigator.mediaDevices
  const hint = $('mic-hint')
  if (!secure) {
    hint.textContent = 'Il microfono funziona solo con il pannello aperto in HTTPS (vedi la guida, "Pannello in HTTPS").'
  } else if (mic.user && !mine) {
    hint.textContent = `Il microfono remoto è già aperto da ${mic.user}.`
  } else if (!mine && micSet[1].device !== null && pianoCattura(micSet, $('mic-headphones').checked).doppio) {
    hint.textContent = 'Microfono 1 e 2 usano lo stesso ingresso e lo stesso canale: scegli un ingresso o un canale diverso per il 2.'
  } else if (!mine && pianoCattura(micSet, $('mic-headphones').checked).senzaEco) {
    hint.textContent = 'Con "Solo canale 1/2" il browser non può togliere l\'eco: usa le cuffie.'
  } else if (mine && !mic.onAir) {
    hint.textContent = 'Microfono aperto, ma NON in onda: in cuffia senti il programma. Premi VAI IN ONDA per parlare.'
  } else hint.textContent = ''
  hint.hidden = !hint.textContent
  $('mic-open').hidden = mine
  $('mic-open').disabled = !secure || micBusy || (mic.user && !mine)
  $('mic-air').hidden = !mine
  $('mic-air').disabled = micBusy
  $('mic-air').textContent = mic.onAir && mine ? '● IN ONDA · premi per uscire' : 'VAI IN ONDA'
  $('mic-air').classList.toggle('live', mic.onAir && mine)
  $('mic-close').hidden = !mine
  $('mic-meter').hidden = !mine
  renderMicChannels()
}

function waitIce(conn) {
  return new Promise((resolve) => {
    if (conn.iceGatheringState === 'complete') return resolve()
    const t = setTimeout(resolve, 2500)
    conn.addEventListener('icegatheringstatechange', () => {
      if (conn.iceGatheringState === 'complete') {
        clearTimeout(t)
        resolve()
      }
    })
  })
}

async function micOpen() {
  micBusy = true
  renderMic()
  try {
    // con le cuffie niente elaborazioni del browser (voce più naturale); senza cuffie serve togliere l'eco
    const hp = $('mic-headphones').checked
    const piano = pianoCattura(micSet, hp)
    if (piano.doppio) throw new Error('Microfono 1 e 2 sono uguali: scegli un ingresso o un canale diverso per il microfono 2')
    micMix = await apriMixMicrofoni(piano, micSet.map((m) => m.vol), micSet.map((m) => m.muted))
    micLoadInputs(false) // dopo il permesso il browser mostra i nomi veri degli ingressi
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    const conn = pc
    for (const t of micMix.stream.getAudioTracks()) conn.addTrack(t, micMix.stream)
    conn.ontrack = (e) => {
      const a = $('mic-ret')
      a.srcObject = e.streams[0] || new MediaStream([e.track])
      a.volume = Number($('mic-return').value)
      a.play().catch(() => {})
    }
    conn.onconnectionstatechange = () => {
      if (pc === conn && conn.connectionState === 'failed') micShutdown('Collegamento audio con il ponte caduto: microfono chiuso')
    }
    await conn.setLocalDescription(await conn.createOffer())
    await waitIce(conn)
    const ans = await request({ t: 'rtc-offer', sdp: conn.localDescription.sdp })
    if (pc !== conn) return
    await conn.setRemoteDescription({ type: 'answer', sdp: ans.sdp })
    startMeter()
  } catch (e) {
    micShutdown(
      e.name === 'NotAllowedError'
        ? 'Permesso del microfono negato dal browser'
        : e.name === 'NotFoundError' || e.name === 'OverconstrainedError'
          ? 'Ingresso del microfono non trovato: controlla che sia collegato e sceglilo di nuovo'
          : e.message
    )
  } finally {
    micBusy = false
    renderMic()
  }
}

function micShutdown(message) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'rtc-close' }))
  if (pc) pc.close()
  pc = null
  if (micMix) micMix.stop()
  micMix = null
  $('mic-ret').srcObject = null
  if (message) notice(message)
  renderMic()
}

function startMeter() {
  const mix = micMix
  const buf = new Float32Array(1024)
  const paint = (bar, an) => {
    const { db, pct } = livelloMic(an, buf)
    bar.style.width = `${pct}%`
    bar.classList.toggle('clip', db > -3)
    bar.classList.toggle('hot', db <= -3 && db > -12)
  }
  const draw = () => {
    if (micMix !== mix) return
    paint($('mic-level'), mix.tot)
    mix.mic.forEach((m, i) => { if (m) paint(micChEls(i).level, m.an) })
    requestAnimationFrame(draw)
  }
  draw()
}

function micApplyGain(i) {
  const g = micMix && micMix.mic[i]
  if (g) g.gain.gain.setTargetAtTime(micSet[i].muted ? 0 : micSet[i].vol, micMix.ctx.currentTime, 0.02)
}

for (const i of [0, 1]) {
  const e = micChEls(i)
  e.dev.addEventListener('focus', () => { if (!micInputsNamed) void micLoadInputs(true) })
  e.dev.addEventListener('change', () => {
    micSet[i].device = e.dev.value === '__none' ? null : e.dev.value
    micSave()
    renderMic()
  })
  e.chan.addEventListener('change', () => {
    micSet[i].channel = e.chan.value
    micSave()
    renderMic()
  })
  e.vol.addEventListener('input', () => {
    micSet[i].vol = Number(e.vol.value)
    micSave()
    micApplyGain(i)
  })
  e.mute.addEventListener('click', () => {
    micSet[i].muted = !micSet[i].muted
    micSave()
    micApplyGain(i)
    renderMicChannels()
  })
}
$('mic-headphones').addEventListener('change', () => renderMic())
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => void micLoadInputs(false))
}
void micLoadInputs(false)

$('mic-open').addEventListener('click', () => void micOpen())
$('mic-close').addEventListener('click', () => micShutdown())
$('mic-air').addEventListener('click', async () => {
  micBusy = true
  renderMic()
  try {
    await request({ t: 'mic', on: !mic.onAir })
  } catch (e) {
    notice(e.message)
  } finally {
    micBusy = false
    renderMic()
  }
})
$('mic-return').addEventListener('input', () => ($('mic-ret').volume = Number($('mic-return').value)))

// ---------- ospiti ----------

let guestList = null
const guestCmd = (cmd) => request({ t: 'guest', cmd })
const guestAct = (cmd) => guestCmd(cmd).catch((e) => notice(e.message))

function renderGuests() {
  const card = $('guests-card')
  card.hidden = !me || guestList === null
  if (card.hidden) return
  const ctl = canCommand()
  $('guests-ctl').hidden = !ctl
  const live = guestList.filter((g) => g.onAir).length
  $('guests-count').textContent = guestList.length ? `${guestList.length} ${guestList.length === 1 ? 'collegato' : 'collegati'}${live ? ` · ${live} in onda` : ''}` : ''
  $('guests-count').className = `mic-who ${live ? 'onair' : ''}`
  const box = $('guests-list')
  box.replaceChildren()
  if (!guestList.length) box.append(el('p', 'hint', 'Nessun ospite collegato. Crea un link e mandalo all\'ospite.'))
  for (const g of guestList) {
    const row = el('div', 'g-row')
    const name = el('div', 'g-name', g.name)
    name.append(el('small', null, g.state === 'attesa' ? `in sala d'attesa da ${hhmm(g.since)}` : g.connected ? (g.onAir ? 'IN ONDA' : 'collegato, fuori onda') : 'si sta collegando…'))
    const linea = g.connected ? lineaEl(g.linea) : null
    if (linea) name.append(linea)
    row.append(name)
    if (ctl) {
      if (g.state === 'attesa') {
        row.append(button('Fai entrare', '', () => guestAct({ type: 'admit', id: g.id }), 'primary small'), button('Rifiuta', '', () => guestAct({ type: 'reject', id: g.id }), 'small'))
      } else {
        const air = button(g.onAir ? '● IN ONDA' : 'Metti in onda', g.onAir ? 'Togli dall\'onda' : '', () => guestAct({ type: 'air', id: g.id, on: !g.onAir }), `small ${g.onAir ? 'live' : ''}`)
        air.disabled = !g.connected
        row.append(air, button('Chiudi', "Chiude l'ospite e revoca il link con cui è entrato", () => guestAct({ type: 'kick', id: g.id }).then(() => $('invites-list').hidden || loadInvites()), 'small ghost'))
      }
    }
    box.append(row)
  }
}

function inviteUrl(inv) {
  return `${location.origin}/ospite.html?t=${encodeURIComponent(inv.token)}`
}

$('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    const inv = await guestCmd({ type: 'invite', label: $('invite-label').value.trim() })
    $('invite-url').value = inviteUrl(inv)
    $('invite-out').hidden = false
    $('invite-share').hidden = !navigator.share
    $('invite-label').value = ''
    if (!$('invites-list').hidden) loadInvites()
  } catch (err) {
    notice(err.message)
  }
})
$('invite-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('invite-url').value)
    notice('Link copiato')
  } catch {
    $('invite-url').select()
  }
})
$('invite-share').addEventListener('click', () => {
  navigator.share({ title: 'Invito in radio', text: 'Apri questo link per collegarti in diretta:', url: $('invite-url').value }).catch(() => {})
})

async function loadInvites() {
  const ul = $('invites-list')
  try {
    const list = await guestCmd({ type: 'invites' })
    ul.replaceChildren()
    if (!list.length) ul.append(el('li', 'hint', 'Nessun link attivo'))
    for (const inv of list) {
      const li = el('li')
      const main = el('div', 't-main')
      main.append(el('div', 't-title', inv.label || 'senza nome'), el('div', 't-artist', `di ${inv.by}, scade alle ${hhmm(inv.expiresAt)}`))
      li.append(
        main,
        button('Copia', '', () => navigator.clipboard.writeText(inviteUrl(inv)).then(() => notice('Link copiato'), () => {}), 'small'),
        button('Revoca', 'Il link smette di funzionare', () => guestCmd({ type: 'revoke', token: inv.token }).then(loadInvites, (e) => notice(e.message)), 'small')
      )
      ul.append(li)
    }
  } catch (err) {
    ul.replaceChildren(el('li', 'error', err.message))
  }
}
$('invites-show').addEventListener('click', () => {
  $('invites-list').hidden = !$('invites-list').hidden
  if (!$('invites-list').hidden) loadInvites()
})

// ---------- diretta autonoma ----------

let auto = null
let autoBrowsed = false
let libBrowsed = false
const autoCmd = (cmd) => request({ t: 'auto', cmd })

function renderAuto() {
  const card = $('auto-card')
  card.hidden = !me || !auto
  if (card.hidden) return
  const ctl = canCommand()
  card.classList.toggle('live', auto.active)
  const badge = $('auto-badge')
  badge.textContent = auto.active ? 'IN ONDA' : ''
  badge.className = `mic-who ${auto.active ? 'auto' : ''}`
  $('auto-hint').textContent = !auto.libraryCount
    ? 'La libreria del server è vuota: carica qualche brano qui sotto o copia la libreria dalla regia.'
    : auto.active
      ? `Il ponte suona la libreria del server (${auto.libraryCount} brani) al posto della regia. Con la coda vuota sceglie da solo.`
      : `Il ponte suona la libreria del server (${auto.libraryCount} brani) al posto della regia. Quando la avvii compare la libreria per scegliere i brani.`
  const now = $('auto-now')
  now.replaceChildren()
  if (auto.active && auto.onAir) {
    now.append(el('div', 'now-title', auto.onAir.title), el('div', 'now-artist', auto.onAir.artist))
  }
  if (auto.active && auto.prepared) now.append(el('div', 'hint', `Prossimo: ${auto.prepared.artist} · ${auto.prepared.title}`))
  $('auto-start').hidden = auto.active
  $('auto-start').disabled = !ctl || !auto.libraryCount
  $('auto-skip').hidden = !auto.active
  $('auto-stop').hidden = !auto.active
  $('auto-skip').disabled = $('auto-stop').disabled = !ctl
  // libreria e coda solo quando si è in diretta autonoma (richiesta di cristian, 23/11/2026)
  $('auto-lib').hidden = !auto.active
  const ul = $('auto-queue')
  ul.replaceChildren()
  if (!auto.queue.length) ul.append(el('li', 'hint', 'Coda vuota: il server sceglie da solo'))
  for (const t of auto.queue) {
    const li = trackRow(t)
    if (ctl) {
      const a = el('div', 't-actions')
      a.append(button('✕', 'Togli dalla coda', () => autoCmd({ type: 'remove', uid: t.uid }).catch((e) => notice(e.message)), 'small'))
      li.append(a)
    }
    ul.append(li)
  }
  $('auto-file').disabled = !ctl
  // il caricamento serve anche prima di partire se la libreria del server è vuota
  $('auto-upload-btn').hidden = !ctl || !(auto.active || !auto.libraryCount)
}

for (const [id, type] of [['auto-start', 'start'], ['auto-skip', 'skip'], ['auto-stop', 'stop']]) {
  $(id).addEventListener('click', () => autoCmd({ type }).catch((e) => notice(e.message)))
}

$('auto-search-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const ul = $('auto-results')
  ul.replaceChildren(el('li', 'hint', 'Ricerca…'))
  try {
    const tracks = await autoCmd({ type: 'search', q: $('auto-q').value.trim() })
    ul.replaceChildren()
    if (!tracks.length) ul.append(el('li', 'hint', 'Nessun brano trovato sul server'))
    for (const t of tracks) {
      const li = trackRow(t)
      if (canCommand()) {
        const a = el('div', 't-actions')
        a.append(
          button('⤒', 'Metti come prossimo', () => autoCmd({ type: 'enqueue', id: t.id, where: 'next' }).then(() => notice(`"${t.title}" è il prossimo`), (e) => notice(e.message)), 'small'),
          button('+', 'Aggiungi in fondo alla coda', () => autoCmd({ type: 'enqueue', id: t.id, where: 'end' }).then(() => notice(`"${t.title}" aggiunto in coda`), (e) => notice(e.message)), 'small')
        )
        li.append(a)
      }
      ul.append(li)
    }
  } catch (err) {
    ul.replaceChildren(el('li', 'error', err.message))
  }
})

function uploadOne(file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('PUT', `/api/autonoma/carica?nome=${encodeURIComponent(file.name)}`)
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    x.onload = () => {
      let body = {}
      try { body = JSON.parse(x.responseText) } catch {}
      x.status === 200 ? resolve(body.track) : reject(new Error(body.error || `errore ${x.status}`))
    }
    x.onerror = () => reject(new Error('caricamento interrotto'))
    x.send(file)
  })
}

$('auto-file').addEventListener('change', async (e) => {
  const files = [...e.target.files]
  e.target.value = ''
  const msg = $('auto-upload')
  msg.hidden = false
  for (const [i, f] of files.entries()) {
    try {
      const t = await uploadOne(f, (p) => (msg.textContent = `Caricamento ${i + 1} di ${files.length}: ${f.name} ${Math.round(p * 100)}%`))
      await autoCmd({ type: 'enqueue', id: t.id, where: 'end' })
      msg.textContent = `"${t.title}" caricato e messo in coda`
    } catch (err) {
      msg.textContent = `${f.name}: ${err.message}`
    }
  }
})

// ---------- dirette video ----------

let video = null
const videoCmd = (cmd) => request({ t: 'video', cmd })
const VIDEO_STATE = {
  spenta: 'Spenta',
  avvio: 'In partenza…',
  attesa_obs: 'In attesa del video da OBS: avvia la trasmissione in OBS',
  in_onda: 'IN ONDA',
  errore: 'Ferma per un errore'
}
const DEST = { youtube: 'YouTube', facebook: 'Facebook' }
let logoShown = null

function renderVideo() {
  const card = $('video-card')
  card.hidden = !me || !video
  if (card.hidden) return
  const ctl = canCommand()
  const on = video.state !== 'spenta' && video.state !== 'errore'
  card.classList.toggle('live', video.state === 'in_onda')
  const badge = $('video-badge')
  badge.textContent = video.state === 'in_onda' ? 'IN ONDA' : on ? '…' : ''
  badge.className = `mic-who ${video.state === 'in_onda' ? 'onair' : ''}`
  const parts = [VIDEO_STATE[video.state] || video.state]
  if (on) {
    parts.push(`${video.source === 'obs' ? 'video da OBS' : 'logo'} → ${video.destinations.map((d) => DEST[d]).join(' e ')}`)
    if (video.since) parts.push(`dalle ${hhmm(video.since)}`)
    if (video.by) parts.push(`avviata da ${video.by}`)
  }
  if (video.detail) parts.push(video.detail)
  if (video.error) parts.push(`⚠ ${video.error}`)
  $('video-status').textContent = parts.join(' · ')
  $('video-ctl').hidden = !ctl
  $('video-start').hidden = on
  $('video-stop').hidden = !on
  for (const r of document.querySelectorAll('input[name="video-src"]')) r.disabled = on
  $('video-yt').disabled = on || !video.youtube
  $('video-fb').disabled = on || !video.facebook
  $('video-yt').parentElement.title = video.youtube ? '' : 'Manca la chiave di YouTube (Impostazioni qui sotto)'
  $('video-fb').parentElement.title = video.facebook ? '' : 'Manca la chiave di Facebook (Impostazioni qui sotto)'
  if (!video.youtube) $('video-yt').checked = false
  if (!video.facebook) $('video-fb').checked = false
  const obs = document.querySelector('input[name="video-src"]:checked').value === 'obs'
  $('video-obs-hint').hidden = !obs
  $('video-obs-hint').textContent =
    `In OBS: Impostazioni → Stream → Servizio "Personalizzato", Server srt://${location.hostname}:${video.obsPort}` +
    (video.obsPassphrase ? '?passphrase=<frase segreta VIDEO_OBS_PASSPHRASE>' : '') +
    ', chiave vuota. Uscita 1280×720, x264, intervallo fotogrammi chiave 2 s, 2500-4000 kbps. Prima avvia qui, poi "Avvia trasmissione" in OBS.'+
    (video.obsPassphrase ? '' : ' Attenzione: manca la frase segreta del video da OBS (Impostazioni del server): senza, la diretta da OBS non parte.')
  $('video-delay').value = video.delayMs
  $('video-settings').hidden = me.role !== 'amministratore'
  if (video.hasLogo && logoShown !== true) {
    $('video-logo').src = `/api/video/logo?${Date.now()}`
    logoShown = true
  }
  $('video-logo').hidden = !video.hasLogo
}
for (const r of document.querySelectorAll('input[name="video-src"]')) r.addEventListener('change', renderVideo)

$('video-start').addEventListener('click', () => {
  const source = document.querySelector('input[name="video-src"]:checked').value
  const destinations = [['video-yt', 'youtube'], ['video-fb', 'facebook']].filter(([id]) => $(id).checked).map(([, d]) => d)
  videoCmd({ type: 'start', source, destinations }).catch((e) => notice(e.message))
})
$('video-stop').addEventListener('click', () => videoCmd({ type: 'stop' }).catch((e) => notice(e.message)))

$('video-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const cmd = { type: 'config', delayMs: Number($('video-delay').value) || 0 }
  if ($('video-yt-key').value.trim()) cmd.youtubeKey = $('video-yt-key').value.trim()
  if ($('video-fb-key').value.trim()) cmd.facebookKey = $('video-fb-key').value.trim()
  if ($('video-fb-url').value.trim()) cmd.facebookUrl = $('video-fb-url').value.trim()
  try {
    await videoCmd(cmd)
    $('video-yt-key').value = $('video-fb-key').value = ''
    notice('Impostazioni delle dirette video salvate')
  } catch (err) {
    notice(err.message)
  }
})

$('video-logo-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]
  e.target.value = ''
  if (!f) return
  try {
    const r = await fetch('/api/video/logo', { method: 'PUT', credentials: 'same-origin', body: f })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || `errore ${r.status}`)
    logoShown = false
    notice('Logo caricato')
  } catch (err) {
    notice(err.message)
  }
})

// ---------- utenti ----------

$('users-btn').addEventListener('click', () => {
  $('menu').hidden = true
  $('main').hidden = true
  $('progs').hidden = true
  $('stats').hidden = true
  $('ann').hidden = true
  $('imp').hidden = true
  $('eventi').hidden = true
  $('users').hidden = false
  loadUsers()
})
$('users-close').addEventListener('click', () => {
  $('users').hidden = true
  $('main').hidden = false
})

function drawUsers(list) {
  const tb = $('users-list')
  tb.replaceChildren()
  for (const u of list) {
    const tr = el('tr')
    tr.append(el('td', null, u.name), el('td', null, u.role))
    const td = el('td')
    if (u.name !== me.name) {
      td.append(
        button('Elimina', '', async () => {
          if (!confirm(`Eliminare l'utente ${u.name}?`)) return
          try {
            const r = await api(`/api/utenti/${encodeURIComponent(u.name)}`, { method: 'DELETE' })
            drawUsers(r.users)
            if (r.invites) drawUserInvites(r.invites)
          } catch (e) {
            $('user-msg').textContent = e.message
          }
        }, 'small')
      )
    }
    tr.append(td)
    tb.append(tr)
  }
}

const ROLE_NAME = { amministratore: 'Amministratore', conduttore: 'Conduttore', ospite: 'Ospite' }
let userInviteDays = 7

function userInviteUrl(inv) {
  // il codice dopo # non arriva nei registri del server né ad altri siti
  return `${location.origin}/invito.html#t=${encodeURIComponent(inv.token)}`
}

function dayMonth(iso) {
  return new Date(iso).toLocaleString('it-IT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
}

function drawUserInvites(list) {
  const ul = $('uinv-list')
  ul.replaceChildren()
  $('uinv-wait').hidden = !list || !list.length
  for (const inv of list || []) {
    const li = el('li')
    const main = el('div', 't-main')
    main.append(el('div', 't-title', `${inv.name} · ${ROLE_NAME[inv.role] || inv.role}`), el('div', 't-artist', `invitato da ${inv.by}, scade il ${dayMonth(inv.expiresAt)}`))
    li.append(
      main,
      button('Copia link', '', () => navigator.clipboard.writeText(userInviteUrl(inv)).then(() => notice('Link copiato'), () => {}), 'small'),
      button('Annulla', 'Il link smette di funzionare', async () => {
        if (!confirm(`Annullare l'invito per ${inv.name}? Il link smetterà di funzionare.`)) return
        try {
          drawUserInvites((await api(`/api/utenti/inviti/${encodeURIComponent(inv.token)}`, { method: 'DELETE' })).invites)
          if ($('uinv-url').value === userInviteUrl(inv)) $('uinv-out').hidden = true
        } catch (e) {
          $('uinv-msg').textContent = e.message
        }
      }, 'small')
    )
    ul.append(li)
  }
}

async function loadUsers() {
  try {
    const r = await api('/api/utenti')
    if (r.inviteDays) userInviteDays = r.inviteDays
    drawUsers(r.users)
    drawUserInvites(r.invites)
  } catch (e) {
    $('user-msg').textContent = e.message
  }
}

$('uinv-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('uinv-msg').textContent = ''
  try {
    const r = await api('/api/utenti/inviti', {
      method: 'POST',
      body: JSON.stringify({ name: $('uinv-name').value.trim(), role: $('uinv-role').value })
    })
    $('uinv-url').value = userInviteUrl(r.invite)
    $('uinv-hint').textContent = `Mandalo a ${r.invite.name} (per esempio su WhatsApp). Vale ${userInviteDays} giorni e una volta sola.`
    $('uinv-out').hidden = false
    $('uinv-share').hidden = !navigator.share
    $('uinv-name').value = ''
    drawUserInvites(r.invites)
  } catch (err) {
    $('uinv-msg').textContent = err.message
  }
})
$('uinv-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('uinv-url').value)
    notice('Link copiato')
  } catch {
    $('uinv-url').select()
  }
})
$('uinv-share').addEventListener('click', () => {
  navigator.share({ title: 'Invito al pannello della radio', text: 'Apri questo link e scegli la tua password:', url: $('uinv-url').value }).catch(() => {})
})

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    const r = await api('/api/utenti', {
      method: 'POST',
      body: JSON.stringify({ name: $('u-name').value.trim(), role: $('u-role').value, password: $('u-pass').value || undefined })
    })
    drawUsers(r.users)
    if (r.invites) drawUserInvites(r.invites)
    $('user-msg').textContent = `Utente ${r.user.name} salvato`
    $('u-name').value = ''
    $('u-pass').value = ''
  } catch (err) {
    $('user-msg').textContent = err.message
  }
})

// ---------- brani sconosciuti delle dirette esterne ----------

function unkDate(iso) {
  return new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function unkItem(u) {
  const li = el('li', 'unk-item')
  const head = el('div', 'unk-head')
  const times = u.heard.length > 1 ? ` · sentito ${u.heard.length} volte` : ''
  head.append(el('b', null, u.label ? `${u.label.artist} - ${u.label.title}` : `Sentito il ${unkDate(u.heard[0])}`))
  head.append(el('span', 'hint', ` ${Math.round(u.seconds / 60)} min${times}`))
  const audio = el('audio')
  audio.controls = true
  audio.preload = 'none'
  audio.src = `/api/sconosciuti/clip?id=${encodeURIComponent(u.id)}`
  li.append(head, audio)
  if (!canCommand()) return li
  const form = el('form', 'unk-form')
  const field = (name, ph, value) => {
    const i = el('input')
    i.name = name
    i.placeholder = ph
    i.value = value || ''
    i.autocomplete = 'off'
    return i
  }
  const l = u.label || {}
  form.append(
    field('title', 'Titolo', l.title),
    field('artist', 'Interprete', l.artist),
    field('composer', 'Autori, separati da virgola (per la SIAE)', l.composer),
    field('publisher', 'Editore (se lo sai)', l.publisher)
  )
  const row = el('div', 'row')
  row.append(el('button', 'primary', u.label ? 'Salva le modifiche' : 'Salva'))
  row.append(
    button('Non è musica', 'Era parlato o rumore: lo toglie dall\'archivio', async (e) => {
      e.preventDefault()
      if (!confirm('Togliere questo audio dall\'archivio? Non sarà più riconosciuto.')) return
      try {
        drawUnknowns((await api('/api/sconosciuti', { method: 'POST', body: JSON.stringify({ id: u.id, azione: 'scarta' }) })).items)
      } catch (err) {
        notice(err.message)
      }
    }, 'ghost')
  )
  form.append(row)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(form))
    try {
      drawUnknowns((await api('/api/sconosciuti', { method: 'POST', body: JSON.stringify({ id: u.id, ...data }) })).items)
      notice('Salvato: da ora il brano viene riconosciuto e va nel report SIAE')
    } catch (err) {
      notice(err.message)
    }
  })
  li.append(form)
  return li
}

let unkInfo = { attivo: false, ultimo: null }
function drawUnknowns(items) {
  const todo = items.filter((u) => !u.label)
  const done = items.filter((u) => u.label)
  // non ridisegnare mentre si sta scrivendo un'etichetta
  if (document.activeElement && $('unk-card').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return
  $('unk-list').replaceChildren(...todo.map(unkItem))
  $('unk-done').replaceChildren(...done.map(unkItem))
  $('unk-done-box').hidden = !done.length
  $('unk-done-title').textContent = `Già etichettati (${done.length})`
  $('unk-badge').textContent = todo.length ? `${todo.length} da etichettare` : ''
  const last = unkInfo.ultimo ? ` Ultimo riconosciuto: ${unkInfo.ultimo.artist} - ${unkInfo.ultimo.title} (${hhmm(unkInfo.ultimo.at)}).` : ''
  $('unk-status').textContent =
    (unkInfo.attivo ? 'Diretta esterna in corso: il server sta riconoscendo i brani.' : 'Il server riconosce i brani durante le dirette esterne.') +
    last +
    (todo.length
      ? ' Ascolta i brani qui sotto e scrivi titolo e interprete: dalla volta dopo saranno riconosciuti da soli.'
      : ' Nessun brano da etichettare.')
}

async function loadUnknowns() {
  try {
    const r = await api('/api/sconosciuti')
    unkInfo = { attivo: r.attivo, ultimo: r.ultimo }
    drawUnknowns(r.items)
  } catch {
    // pannello non ancora collegato: si riprova al prossimo giro
  }
}
setInterval(() => !$('app').hidden && loadUnknowns(), 60_000)

setInterval(() => state && studio && renderNow(), 250)
start()

// ---------- app Radio Esterna: chi è fuori, se è in onda, e ascolto prima del passaggio ----------
let esternaAscolto = null
function renderEsterna(st) {
  const card = $('esterna-card')
  const audio = $('esterna-audio')
  const visibile = !!st && (st.collegata || st.inOnda)
  card.hidden = !visibile
  card.classList.toggle('live', !!st?.inOndaDavvero)
  if (!visibile) {
    esternaAscolto = null
    audio.pause()
    audio.removeAttribute('src')
    $('esterna-ascolta').textContent = '🎧 Ascolta chi è fuori (solo tu)'
    return
  }
  // frasi semplici, come in regia (27/11/2026)
  $('esterna-stato').textContent = st.inOndaDavvero
    ? '🔴 In onda da fuori'
    : st.inOnda
      ? '🟠 Chi è fuori ha premuto IN ONDA, ma la sua voce non arriva: va ancora lo studio'
      : st.audio
        ? '📡 Collegato da fuori e pronto: non è ancora in onda'
        : '📡 Si sta collegando da fuori…'
  $('esterna-chi').textContent = st.user ? `· ${st.user}` : ''
  $('esterna-titolo').textContent = st.titolo || ''
  const linea = st.collegata ? lineaEl(st.linea, st.via) : null
  $('esterna-linea').replaceChildren(...(linea ? [linea] : []))
  $('esterna-linea').hidden = !linea
  // token cambiato (nuova connessione dell'app): l'ascolto si riapre con quello nuovo
  if (esternaAscolto !== st.ascolto) {
    const eraInAscolto = !audio.paused
    esternaAscolto = st.ascolto
    if (eraInAscolto && st.ascolto) {
      audio.src = `/api/esterna/ascolta?t=${encodeURIComponent(st.ascolto)}`
      audio.play().catch(() => {})
    }
  }
}
$('esterna-ascolta').addEventListener('click', () => {
  const audio = $('esterna-audio')
  if (!audio.paused) {
    audio.pause()
    audio.removeAttribute('src')
    $('esterna-ascolta').textContent = '🎧 Ascolta chi è fuori (solo tu)'
    return
  }
  if (!esternaAscolto) return
  audio.src = `/api/esterna/ascolta?t=${encodeURIComponent(esternaAscolto)}`
  audio
    .play()
    .then(() => ($('esterna-ascolta').textContent = '■ Smetti di ascoltare'))
    .catch(() => ($('esterna-nota').textContent = "L'audio dell'esterna non arriva ancora: riprova tra poco."))
})

// ---------- titolo parlato (scelte di cristian, 24/11/2026) ----------
// Quando non suona nessun brano il ponte manda come titolo il programma e il conduttore (o il nome della radio).
// Qui si vede cosa va in onda e si scrive un testo libero (es. "Ospite: Mario Rossi").

let tpTimer = null
let tpEditing = false

function renderSpokenTitle(s) {
  $('tp-card').hidden = false
  $('tp-onda').hidden = !s.inOnda
  $('tp-anteprima').textContent = `${s.artist ? `${s.artist} – ` : ''}${s.title}`
  if (!tpEditing) $('tp-testo').value = s.testo
  $('tp-testo').maxLength = s.max
  $('tp-testo').placeholder = s.programma ? 'Testo in più, es. Ospite: Mario Rossi' : 'Testo al posto dello slogan'
  $('tp-togli').hidden = !s.testo || !canCommand()
  $('tp-form').hidden = !canCommand()
  $('tp-hint').textContent = s.programma
    ? `Va in onda dopo 5 secondi senza brani. Il testo vale fino alla fine di "${s.programma}".`
    : 'Va in onda dopo 5 secondi senza brani. Nessun programma in palinsesto adesso: va il nome della radio.'
}

async function loadSpokenTitle() {
  clearTimeout(tpTimer)
  if (!me) return
  try {
    renderSpokenTitle(await api('/api/titolo-parlato'))
  } catch {
    $('tp-card').hidden = true
  }
  tpTimer = setTimeout(loadSpokenTitle, 15000)
}

async function saveSpokenText(testo) {
  try {
    tpEditing = false
    renderSpokenTitle(await api('/api/titolo-parlato', { method: 'POST', body: JSON.stringify({ testo }) }))
  } catch (e) {
    notice(e.message)
  }
}

$('tp-testo').addEventListener('input', () => (tpEditing = true))
$('tp-form').addEventListener('submit', (e) => {
  e.preventDefault()
  void saveSpokenText($('tp-testo').value)
})
$('tp-togli').addEventListener('click', () => void saveSpokenText(''))
