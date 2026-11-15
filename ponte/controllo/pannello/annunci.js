// Pannello remoto: annunci a orario con la voce sintetica, quando trasmette il server.
'use strict'

const ANN_TAGS = ['ora', 'data', 'radio', 'brano', 'artista', 'prossimo_brano', 'prossimo_artista', 'programma', 'prossimo_programma', 'ora_prossimo_programma']
const ANN_DEFAULT = { speed: 1, expressiveness: 0.667, rhythm: 0.8, sentencePause: 0.4, pitch: 0, volumeDb: 0 }
const ANN_SLIDERS = [
  { key: 'speed', label: 'Velocità', min: 0.5, max: 2, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'expressiveness', label: 'Espressività (intonazione)', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'rhythm', label: 'Variazione del ritmo', min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'sentencePause', label: 'Pausa tra le frasi', min: 0, max: 3, step: 0.1, fmt: (v) => `${v.toFixed(1)} s` },
  { key: 'pitch', label: 'Tono', min: -6, max: 6, step: 0.5, fmt: (v) => (v === 0 ? 'normale' : `${v > 0 ? '+' : ''}${v} semitoni`) },
  { key: 'volumeDb', label: 'Volume', min: -12, max: 12, step: 0.5, fmt: (v) => (v === 0 ? 'normale' : `${v > 0 ? '+' : ''}${v} dB`) }
]
let ann = null
let annVoice = null
let annPoll = null

$('ann-btn').addEventListener('click', () => {
  $('menu').hidden = true
  for (const id of ['main', 'users', 'progs', 'stats']) $(id).hidden = true
  $('ann').hidden = false
  loadAnn()
})
$('ann-close').addEventListener('click', () => {
  $('ann').hidden = true
  $('main').hidden = false
})

async function loadAnn() {
  try {
    drawAnn(await api('/api/annunci'))
  } catch (e) {
    notice(e.message)
  }
}

function drawVoices(voices) {
  ann.voices = voices
  const sel = $('ann-voice')
  sel.replaceChildren(
    ...voices.map((v) => {
      const o = el('option', null, `${v.name}, ${v.description}${v.installed ? '' : v.downloading ? ' (la sto scaricando…)' : ` (da scaricare, ${v.sizeMb} MB)`}`)
      o.value = v.id
      return o
    })
  )
  sel.value = annVoice.voice
  const v = voices.find((x) => x.id === annVoice.voice)
  const b = $('ann-voice-get')
  b.hidden = !v || v.installed
  b.disabled = !!v?.downloading
  if (v) b.textContent = v.downloading ? 'Scarico la voce…' : `Scarica ${v.name} adesso`
  // durante lo scaricamento si ricontrolla ogni pochi secondi
  clearTimeout(annPoll)
  if (voices.some((x) => x.downloading)) {
    annPoll = setTimeout(async () => !$('ann').hidden && drawVoices((await api('/api/annunci')).voices), 3000)
  }
}

function drawAnn(s) {
  ann = s
  annVoice = { ...s.voice }
  $('ann-status').textContent = s.waiting ? `${s.waiting} annuncio pronto in attesa di andare in onda.` : ''
  $('ann-radio').value = s.radio
  $('ann-radio').placeholder = s.stationName
  drawVoices(s.voices)
  drawSliders()
  $('ann-tags').replaceChildren(...ANN_TAGS.map((t) => el('code', null, `{${t}} `)))
  $('ann-list').replaceChildren(...s.items.map(annRow))
  $('ann-msg').textContent = ''
}

function drawSliders() {
  $('ann-sliders').replaceChildren(
    ...ANN_SLIDERS.map((d) => {
      const l = el('label', null, '')
      const t = el('span', null, `${d.label} · ${d.fmt(annVoice[d.key])}`)
      const i = el('input')
      Object.assign(i, { type: 'range', min: d.min, max: d.max, step: d.step, value: annVoice[d.key] })
      i.addEventListener('input', () => {
        annVoice[d.key] = Number(i.value)
        t.textContent = `${d.label} · ${d.fmt(annVoice[d.key])}`
      })
      l.append(t, i)
      return l
    })
  )
}

$('ann-voice').addEventListener('change', (e) => {
  annVoice.voice = e.target.value
  drawVoices(ann.voices)
})
$('ann-voice-get').addEventListener('click', async () => {
  try {
    drawVoices((await api('/api/annunci/voce', { method: 'POST', body: JSON.stringify({ id: annVoice.voice }) })).voices)
  } catch (e) {
    $('ann-voice-msg').textContent = e.message
  }
})
$('ann-reset').addEventListener('click', () => {
  annVoice = { ...ANN_DEFAULT, voice: annVoice.voice }
  drawSliders()
})

function annRow(a) {
  const li = el('li', 'ann-item')
  li.dataset.id = a.id
  const text = el('textarea')
  Object.assign(text, { rows: 2, maxLength: 3000, value: a.text, className: 'ann-text', placeholder: 'Sono le {ora}. State ascoltando {radio}.' })
  const hourly = a.time.startsWith('*')
  const mode = el('select', 'ann-mode')
  for (const [v, l] of [['day', 'Alle'], ['hour', 'Ogni ora al minuto']]) {
    const o = el('option', null, l)
    o.value = v
    mode.append(o)
  }
  mode.value = hourly ? 'hour' : 'day'
  const time = el('input', 'ann-time')
  time.type = 'time'
  time.value = hourly ? '' : a.time
  const minute = el('input', 'ann-minute')
  Object.assign(minute, { type: 'number', min: 0, max: 59, value: hourly ? Number(a.time.slice(2)) : 0 })
  const sync = () => {
    time.hidden = mode.value !== 'day'
    minute.hidden = mode.value !== 'hour'
  }
  mode.addEventListener('change', sync)
  sync()
  const days = el('div', 'days')
  for (const d of DAY_ORDER) {
    const l = el('label', null, DAYS[d])
    const c = el('input')
    Object.assign(c, { type: 'checkbox', value: String(d), checked: a.days.includes(d) })
    l.prepend(c)
    days.append(l)
  }
  const on = el('label', 'check', ' attivo')
  const onC = el('input', 'ann-on')
  Object.assign(onC, { type: 'checkbox', checked: a.enabled })
  on.prepend(onC)
  const msg = el('span', 'hint')
  const player = el('audio')
  player.controls = true
  player.hidden = true
  const test = button('🎧 Ascolta', 'Prova con la voce e le impostazioni qui sopra', async () => {
    msg.textContent = 'Preparo la voce… (la prima volta la scarica: può volerci qualche minuto)'
    try {
      const r = await api('/api/annunci/prova', { method: 'POST', body: JSON.stringify({ text: text.value, voice: annVoice }) })
      msg.textContent = `"${r.text}"${r.missing.length ? ` · adesso non so: ${r.missing.map((m) => `{${m}}`).join(', ')}` : ''}`
      player.src = r.url
      player.hidden = false
      void player.play()
      drawVoices((await api('/api/annunci')).voices)
    } catch (e) {
      msg.textContent = e.message
    }
  }, 'small')
  const del = button('✕', 'Togli l\'annuncio', () => li.remove(), 'small ghost')
  const when = el('div', 'row')
  when.append(mode, time, minute, days, on)
  const actions = el('div', 'row')
  actions.append(test, del, msg)
  li.append(text, when, actions, player)
  return li
}

$('ann-add').addEventListener('click', () => {
  $('ann-list').append(annRow({ id: '', text: 'Sono le {ora}. State ascoltando {radio}.', time: '*:00', days: [0, 1, 2, 3, 4, 5, 6], enabled: true }))
})

$('ann-save').addEventListener('click', async () => {
  const items = [...$('ann-list').querySelectorAll('.ann-item')].map((li) => {
    const mode = li.querySelector('.ann-mode').value
    const minute = String(Math.min(59, Math.max(0, Number(li.querySelector('.ann-minute').value) || 0))).padStart(2, '0')
    return {
      id: li.dataset.id,
      text: li.querySelector('.ann-text').value,
      time: mode === 'hour' ? `*:${minute}` : li.querySelector('.ann-time').value,
      days: [...li.querySelectorAll('.days input:checked')].map((c) => Number(c.value)),
      enabled: li.querySelector('.ann-on').checked
    }
  })
  try {
    drawAnn(await api('/api/annunci', { method: 'POST', body: JSON.stringify({ voice: annVoice, radio: $('ann-radio').value, items }) }))
    $('ann-msg').textContent = 'Salvato.'
  } catch (e) {
    $('ann-msg').textContent = e.message
  }
})
