// Pagina dell'invito: chi ha ricevuto il link sceglie la sua password ed entra nel pannello.
'use strict'

const $ = (id) => document.getElementById(id)
const token = new URLSearchParams(location.hash.slice(1)).get('t') || ''
const ROLE = {
  amministratore: 'amministratore (comandi la regia e gestisci gli utenti)',
  conduttore: 'conduttore (comandi la regia)',
  ospite: 'ospite (vedi la regia)'
}

function bad(text) {
  $('i-form').hidden = true
  $('i-bad').hidden = false
  $('i-bad-text').textContent = text
}

async function call(method, body) {
  const r = await fetch(method === 'GET' ? `/api/invito?t=${encodeURIComponent(token)}` : '/api/invito', {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = new Error(data.error || `errore ${r.status}`)
    e.status = r.status
    throw e
  }
  return data
}

async function start() {
  if (!token) return bad('Nel link manca il codice: copia di nuovo tutto il link che ti hanno mandato.')
  try {
    const inv = await call('GET')
    document.title = `Invito · ${inv.station}`
    $('i-station').textContent = inv.station
    $('i-who').textContent = `Hai un invito per il pannello della radio come ${ROLE[inv.role] || inv.role}. Scegli la tua password: servirà per entrare le prossime volte.`
    $('i-name').value = inv.name
    $('i-form').hidden = false
    $('i-pass').focus()
  } catch (e) {
    bad(e.message)
  }
}

$('i-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = $('i-error')
  err.hidden = true
  const pass = $('i-pass').value
  if (pass.length < 8) {
    err.textContent = 'La password deve avere almeno 8 caratteri'
    return void (err.hidden = false)
  }
  if (pass !== $('i-pass2').value) {
    err.textContent = 'Le due password sono diverse'
    return void (err.hidden = false)
  }
  try {
    await call('POST', { t: token, password: pass })
    // il link è usato: si toglie dalla barra dell'indirizzo ed entra nel pannello
    location.replace('/dashboard')
  } catch (e) {
    if (e.status === 404) return bad(e.message)
    err.textContent = e.message
    err.hidden = false
  }
})

start()
