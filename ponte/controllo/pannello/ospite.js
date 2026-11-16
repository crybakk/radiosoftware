// Pagina dell'ospite: sala d'attesa, poi voce in WebRTC verso il ponte.
'use strict'

const $ = (id) => document.getElementById(id)
const token = new URLSearchParams(location.search).get('t') || ''
let ws = null
let pc = null
let stream = null
let meterCtx = null
let seq = 0
const waiting = new Map()
let ended = false
let inside = false
let retry = null

function show(id) {
  for (const s of ['g-join', 'g-wait', 'g-in', 'g-end']) $(s).hidden = s !== id
  $('g-leave').hidden = !(id === 'g-wait' || id === 'g-in')
}
function error(text) {
  $('g-error').textContent = text
  $('g-error').hidden = !text
}

async function getMic() {
  if (stream) return stream
  if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('Questa pagina deve essere aperta in https:// per usare il microfono.')
  const hp = $('g-headphones').checked
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: !hp, noiseSuppression: !hp, autoGainControl: !hp, channelCount: 1 }
  })
  startMeter()
  return stream
}

function startMeter() {
  meterCtx = new AudioContext()
  const an = meterCtx.createAnalyser()
  an.fftSize = 1024
  meterCtx.createMediaStreamSource(stream).connect(an)
  const buf = new Float32Array(an.fftSize)
  const draw = () => {
    if (!meterCtx) return
    an.getFloatTimeDomainData(buf)
    let peak = 0
    for (const v of buf) peak = Math.max(peak, Math.abs(v))
    const db = peak > 0 ? 20 * Math.log10(peak) : -60
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
    for (const id of ['g-level', 'g-level2']) {
      $(id).style.width = `${pct}%`
      $(id).className = `meter-fill ${db > -3 ? 'clip' : db > -12 ? 'hot' : ''}`
    }
    requestAnimationFrame(draw)
  }
  draw()
}

function request(msg) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('non collegato'))
    const id = `g${++seq}`
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ ...msg, id }))
  })
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

async function connectAudio() {
  let conn = null
  try {
    const s = await getMic()
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    conn = pc
    for (const t of s.getAudioTracks()) conn.addTrack(t, s)
    conn.ontrack = (e) => {
      const a = $('g-ret')
      a.srcObject = e.streams[0] || new MediaStream([e.track])
      a.volume = Number($('g-vol').value)
      a.play().catch(() => {})
    }
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === 'failed' && pc === conn) audioFailed('Collegamento audio caduto: riprovo tra poco…')
    }
    await conn.setLocalDescription(await conn.createOffer())
    await waitIce(conn)
    const ans = await request({ t: 'rtc-offer', sdp: conn.localDescription.sdp })
    if (pc !== conn) return
    await conn.setRemoteDescription({ type: 'answer', sdp: ans.sdp })
    error('')
  } catch (e) {
    // un tentativo vecchio, già sostituito o chiuso: non tocca quello nuovo
    if (conn && pc !== conn) return
    // senza permesso del microfono non si riprova da soli (si riprova al prossimo cambio di stato)
    if (e.name === 'NotAllowedError') audioFailed('Il browser non ha dato il permesso per il microfono.', false)
    else audioFailed(e.message)
  }
}

/** Audio non collegato: si chiude la connessione e si riprova da soli, senza ricaricare la pagina. */
function audioFailed(text, again = true) {
  if (pc) pc.close()
  pc = null
  error(text)
  clearTimeout(retry)
  retry = null
  if (!again) return
  retry = setTimeout(() => {
    retry = null
    if (inside && !ended && !pc && ws && ws.readyState === 1) void connectAudio()
  }, 5000)
}

function cleanup() {
  clearTimeout(retry)
  retry = null
  if (pc) pc.close()
  pc = null
  if (stream) for (const t of stream.getTracks()) t.stop()
  stream = null
  if (meterCtx) meterCtx.close().catch(() => {})
  meterCtx = null
  $('g-radio').pause()
  $('g-radio').removeAttribute('src')
  $('g-ret').srcObject = null
}

function finish(text) {
  ended = true
  cleanup()
  $('g-end-text').textContent = text
  show('g-end')
}

function onState(m) {
  inside = m.state === 'dentro'
  if (m.state === 'attesa') {
    show('g-wait')
  } else if (m.state === 'dentro') {
    $('g-radio').pause()
    show('g-in')
    if (!pc) void connectAudio()
    $('g-air').textContent = m.onAir ? '● IN ONDA' : 'Collegato · FUORI ONDA'
    $('g-air').className = `guest-state ${m.onAir ? 'live' : ''}`
  } else if (m.state === 'rifiutato') {
    finish('Il conduttore non può farti entrare adesso')
  } else if (m.state === 'pieno') {
    finish("La sala d'attesa è piena: riprova tra poco")
    // il ponte chiude la connessione: la si chiude anche da qui
    ws.close()
  } else {
    finish('Collegamento chiuso')
  }
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ospite?t=${encodeURIComponent(token)}`)
  let opened = false
  ws.onopen = () => (opened = true)
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.t === 'hello') {
      document.title = `Ospite · ${m.station}`
      $('g-station').textContent = m.station
      $('g-label').textContent = m.label ? `Invito: ${m.label}` : ''
      if (m.listenUrl) $('g-radio').src = m.listenUrl
      $('g-listen-hint').hidden = !m.listenUrl
      show('g-join')
    } else if (m.t === 'state') {
      onState(m)
    } else if (m.t === 'reply') {
      const w = waiting.get(m.id)
      if (w) {
        waiting.delete(m.id)
        m.ok ? w.resolve(m.data) : w.reject(new Error(m.error || 'errore'))
      }
    }
  }
  ws.onclose = () => {
    if (ended) return
    if (!opened) return finish('Link non valido o scaduto: chiedi un nuovo link al conduttore')
    finish('Collegamento con la radio perso: ricarica la pagina per rientrare')
  }
}

$('g-test').addEventListener('click', () => getMic().then(() => ($('g-meter').hidden = false), (e) => error(e.name === 'NotAllowedError' ? 'Il browser non ha dato il permesso per il microfono.' : e.message)))
$('g-join').addEventListener('submit', async (e) => {
  e.preventDefault()
  error('')
  try {
    await getMic()
  } catch (err) {
    return error(err.name === 'NotAllowedError' ? 'Il browser non ha dato il permesso per il microfono.' : err.message)
  }
  localStorage.setItem('nome-ospite', $('g-name').value)
  ws.send(JSON.stringify({ t: 'join', name: $('g-name').value }))
  if ($('g-radio').src) $('g-radio').play().catch(() => {})
})
$('g-leave').addEventListener('click', () => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'leave' }))
  finish('Sei uscito')
})
$('g-vol').addEventListener('input', () => ($('g-ret').volume = Number($('g-vol').value)))
$('g-name').value = localStorage.getItem('nome-ospite') || ''
if (!token) finish('Link non valido: manca il codice di invito')
else connect()
