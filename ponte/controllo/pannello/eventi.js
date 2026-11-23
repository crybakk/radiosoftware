// Pannello remoto: eventi e rotazioni della regia (richiesta del 23/11/2026).
// Tutto passa dalla regia attraverso il ponte: se la regia è scollegata si vede l'ultimo elenco caricato.
// Elenco e prossimi: tutti; esegui ora e cambio rotazione: chi comanda; modifiche: amministratori.
// Gli eventi con un comando esterno si gestiscono solo dalla regia (🔒).
'use strict'

const EV_DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab']
const EV_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const EV_KIND = { '': 'Qualsiasi', music: 'Musica', jingle: 'Jingle', spot: 'Spot', news: 'Notiziario', program: 'Programma' }
const EV_ACTIONS = {
  play: 'Brano',
  random: 'Brano casuale',
  playlist: 'Playlist',
  stream: 'Flusso esterno',
  mode: 'Automatico / manuale',
  clear: 'Svuota coda',
  stop: 'Ferma tutto',
  rotation: 'Regole di rotazione',
  replay: 'Replica di un programma',
  news: 'Notiziario',
  voice: 'Annuncio vocale',
  djMix: 'Mix DJ',
  command: 'Comando esterno'
}
let evInfo = null
let evDraft = null
let evTracks = new Map()
let evPrograms = []

const evAdmin = () => me && me.role === 'amministratore'

$('eventi-btn').addEventListener('click', () => {
  $('menu').hidden = true
  for (const id of ['main', 'users', 'progs', 'stats', 'ann', 'imp']) $(id).hidden = true
  $('eventi').hidden = false
  closeEvForm()
  loadEvents()
  $('ai-card').hidden = !evAdmin()
  loadAi()
})
$('eventi-close').addEventListener('click', () => {
  $('eventi').hidden = true
  $('main').hidden = false
})
// si aggiorna da solo, ma non mentre si modifica un evento
setInterval(() => !$('eventi').hidden && $('ev-form').hidden && loadEvents(true), 30_000)

function evStatus(text) {
  $('ev-status').textContent = text || ''
  $('ev-status').hidden = !text
}

/** Errore della regia più chiaro: una regia vecchia non conosce questi comandi. */
function evError(e) {
  return /comando sconosciuto/.test(e.message) ? 'Aggiorna la regia dello studio: questa versione non gestisce gli eventi da remoto.' : e.message
}

async function evSend(cmd) {
  const info = await send(cmd)
  drawEvents(info)
  return info
}

async function loadEvents(quiet) {
  if (!studio) {
    evStatus('Regia non collegata al ponte: eventi e rotazioni si comandano quando la regia è accesa e collegata.')
    if (!evInfo) drawEvents(null)
    return
  }
  try {
    await evSend({ type: 'events' })
    evStatus('')
  } catch (e) {
    if (!quiet) evStatus(evError(e))
  }
}

function evWhen(e) {
  if (e.time.startsWith('*')) return `ogni ora al minuto ${e.time.slice(2)}`
  if (e.repeatMinutes > 0) return `dalle ${e.time} ogni ${e.repeatMinutes} min${e.untilTime ? ` fino alle ${e.untilTime}` : ''}`
  return `alle ${e.time}`
}
function evDaysText(days) {
  if (days.length === 7) return 'tutti i giorni'
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return 'lun-ven'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'weekend'
  return EV_DAY_ORDER.filter((d) => days.includes(d)).map((d) => EV_DAYS[d]).join(' ')
}
function evDate(iso) {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}
function evProfileText(p) {
  const parts = [p.name || 'profilo senza nome']
  if (p.genres.length) parts.push(`generi: ${p.genres.join(', ')}`)
  if (p.yearFrom || p.yearTo) parts.push(`anni ${p.yearFrom ?? '…'}-${p.yearTo ?? '…'}`)
  if (p.energyMin != null || p.energyMax != null) parts.push(`energia ${p.energyMin ?? 1}-${p.energyMax ?? 10}`)
  return parts.join(' · ')
}
function evTrackText(id) {
  const t = evTracks.get(id)
  return t ? `${t.artist ? `${t.artist} – ` : ''}${t.title}` : id ? 'brano non trovato' : 'nessun brano scelto'
}

function evActionText(a) {
  switch (a.type) {
    case 'play':
      return evTrackText(a.trackId)
    case 'random':
      return [EV_KIND[a.kind] || 'qualsiasi', a.genre && `genere "${a.genre}"`, a.folder && `da ${a.folder}`].filter(Boolean).join(', ')
    case 'playlist':
      return `${a.path} (${a.placement === 'front' ? 'subito' : a.placement === 'append' ? 'in fondo alla coda' : 'sostituisce la coda'})`
    case 'stream':
      return `${a.title || a.url} per ${a.minutes} min`
    case 'mode':
      return a.mode === 'auto' ? 'passa in automatico' : 'passa in manuale'
    case 'clear':
      return 'svuota la coda'
    case 'stop':
      return 'ferma tutto'
    case 'rotation':
      return a.profile ? `profilo "${a.profile.name || 'senza nome'}"` : 'torna alla rotazione normale'
    case 'command':
      return 'si vede e si cambia solo in regia'
    case 'replay':
      return a.programId ? `ultima puntata di "${a.title || a.programId}"` : 'nessun programma scelto'
    case 'news':
      return a.sourceId ? `ultima edizione di "${a.title || a.sourceId}"` : 'nessuna fonte scelta'
    case 'voice':
      return `"${a.text.length > 80 ? `${a.text.slice(0, 77)}…` : a.text}"`
    case 'djMix':
      return a.on ? 'acceso' : 'spento'
    default:
      return ''
  }
}

function drawEvents(info) {
  if (info) {
    evInfo = info
    for (const t of info.tracks) evTracks.set(t.id, t)
    $('ev-genres').replaceChildren(...info.genres.map((g) => Object.assign(el('option'), { value: g })))
  }
  const ctl = canCommand() && studio
  const admin = evAdmin() && studio
  $('ev-new').hidden = !evAdmin()
  $('ev-new').disabled = !admin
  // rotazione
  const i = evInfo
  $('ev-rot-now').replaceChildren()
  if (i) {
    $('ev-rot-now').append(el('b', null, 'Attiva: '), i.rotation ? evProfileText(i.rotation) : 'rotazione normale (tutta la musica)')
    $('ev-rot-now').append(el('div', 'hint', `Stesso artista non prima di ${i.rules.artistSeparationMinutes} min · stesso brano non prima di ${i.rules.titleSeparationMinutes} min · ${i.rules.jingleEvery > 0 ? `un jingle ogni ${i.rules.jingleEvery} brani` : 'niente jingle automatici'} · Mix DJ ${i.djMix ? 'acceso' : 'spento'}`))
  }
  const sel = $('ev-rot-select')
  sel.replaceChildren(...(i?.profiles ?? []).map((p, n) => Object.assign(el('option', null, p.name || 'senza nome'), { value: String(n) })))
  $('ev-rot-pick').hidden = !canCommand()
  sel.disabled = $('ev-rot-apply').disabled = !ctl || !i?.profiles.length
  $('ev-rot-normal').disabled = !ctl || !i?.rotation
  $('ev-rules-box').hidden = !evAdmin()
  if (i && document.activeElement?.form !== $('ev-rules')) {
    for (const k of ['artistSeparationMinutes', 'titleSeparationMinutes', 'jingleEvery']) $('ev-rules')[k].value = i.rules[k]
  }
  // prossimi
  const byId = new Map((i?.events ?? []).map((e) => [e.id, e]))
  const today = new Date().toDateString()
  $('ev-next').replaceChildren(
    ...(i?.next.length
      ? i.next.map((n) => {
          const d = new Date(n.at)
          const li = el('li')
          li.append(el('span', 't-eta', `${d.toDateString() === today ? '' : `${EV_DAYS[d.getDay()]} `}${hhmm(n.at)}`), el('span', 't-main', byId.get(n.id)?.label || ''))
          return li
        })
      : [el('li', 'hint', i ? 'Nessun evento in programma nei prossimi giorni.' : '')])
  )
  // elenco
  $('ev-list').replaceChildren(
    ...(i?.events.length ? i.events.map((e) => evRow(e, ctl, admin)) : [el('li', 'hint', i ? 'Nessun evento. Creane uno con "+ Nuovo evento" (amministratori).' : '')])
  )
}

function evRow(e, ctl, admin) {
  const li = el('li', `ev-item${e.enabled ? '' : ' off'}`)
  const head = el('div', 'ev-head')
  head.append(el('span', 'ev-when mono', evWhen(e)), el('b', 'ev-name', `${e.locked ? '🔒 ' : ''}${e.label || '(senza nome)'}`))
  const sub = [evDaysText(e.days)]
  if (e.validFrom) sub.push(`dal ${evDate(e.validFrom)}`)
  if (e.validTo) sub.push(`al ${evDate(e.validTo)}`)
  sub.push(e.mode === 'hard' ? 'parte subito' : e.toleranceSeconds > 0 ? `dopo il brano (max ${e.toleranceSeconds} s)` : 'dopo il brano')
  if (!e.enabled) sub.push('SPENTO')
  const ol = el('ol', 'action-summary')
  for (const a of e.actions) {
    const x = el('li')
    x.append(el('b', null, `${EV_ACTIONS[a.type] || a.type}: `), evActionText(a))
    ol.append(x)
  }
  li.append(head, el('div', 'hint', sub.join(' · ')), ol)
  if (e.locked) {
    li.append(el('div', 'hint', 'Lancia un comando sul PC di regia: per sicurezza si gestisce solo dalla regia.'))
    return li
  }
  const row = el('div', 'row')
  if (canCommand()) {
    const run = button('▶ Esegui ora', 'Esegue subito le azioni in regia', async () => {
      if (!confirm(`Eseguire subito l'evento "${e.label || evWhen(e)}"? Le azioni partono adesso in regia.`)) return
      try {
        await evSend({ type: 'eventRun', id: e.id })
        notice(`Eseguito: ${e.label || evWhen(e)}`)
      } catch (err) {
        notice(evError(err))
      }
    }, 'small')
    run.disabled = !ctl
    row.append(run)
  }
  if (evAdmin()) {
    const toggle = button(e.enabled ? '⏸ Spegni' : '✅ Accendi', null, () => evSend({ type: 'eventEnable', id: e.id, on: !e.enabled }).catch((err) => notice(evError(err))), 'small')
    const edit = button('Modifica', null, () => openEvForm(structuredClone(e)), 'small')
    const dup = button('Duplica', null, () => {
      const { id: _id, locked: _l, ...copy } = structuredClone(e)
      openEvForm({ ...copy, label: `${copy.label} (copia)` })
    }, 'small')
    const del = button('Elimina', null, async () => {
      if (!confirm(`Eliminare l'evento "${e.label || evWhen(e)}"?`)) return
      evSend({ type: 'eventDelete', id: e.id }).catch((err) => notice(evError(err)))
    }, 'small danger')
    for (const b of [toggle, edit, dup, del]) b.disabled = !admin
    row.append(toggle, edit, dup, del)
  }
  if (row.childElementCount) li.append(row)
  return li
}

// ---------- rotazione ----------

$('ev-rot-apply').addEventListener('click', async () => {
  const p = evInfo?.profiles[Number($('ev-rot-select').value)]
  if (!p) return
  try {
    await evSend({ type: 'rotationSet', profile: p })
    notice(`Rotazione: ${p.name || 'senza nome'}`)
  } catch (e) {
    notice(evError(e))
  }
})
$('ev-rot-normal').addEventListener('click', () => evSend({ type: 'rotationSet', profile: null }).catch((e) => notice(evError(e))))
$('ev-rules').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const f = ev.target
  try {
    await evSend({
      type: 'rotationRules',
      rules: { artistSeparationMinutes: Number(f.artistSeparationMinutes.value), titleSeparationMinutes: Number(f.titleSeparationMinutes.value), jingleEvery: Number(f.jingleEvery.value) }
    })
    notice('Regole salvate in regia')
  } catch (e) {
    notice(evError(e))
  }
})

// ---------- modifica di un evento ----------

function evNewAction(type) {
  switch (type) {
    case 'play':
      return { type, trackId: 0 }
    case 'random':
      return { type, kind: 'jingle', folder: '', genre: '' }
    case 'playlist':
      return { type, path: '', placement: 'front' }
    case 'stream':
      return { type, url: '', minutes: 60, title: '' }
    case 'mode':
      return { type, mode: 'auto' }
    case 'rotation':
      return { type, profile: { name: '', genres: [], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null, energyMin: null, energyMax: null } }
    case 'replay':
      return { type, programId: '', title: '' }
    case 'news':
      return { type, sourceId: '', title: '' }
    case 'voice':
      return { type, text: 'Sono le {ora}. Avete ascoltato {brano} di {artista}.' }
    case 'djMix':
      return { type, on: true }
    default:
      return { type }
  }
}

$('ev-add-type').replaceChildren(
  ...Object.entries(EV_ACTIONS)
    .filter(([k]) => k !== 'command')
    .map(([k, v]) => Object.assign(el('option', null, v), { value: k }))
)
$('ev-add').addEventListener('click', () => {
  evDraft.actions.push(evNewAction($('ev-add-type').value))
  drawEvActions()
})
$('ev-new').addEventListener('click', () =>
  openEvForm({ label: '', time: '', days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null, validFrom: null, validTo: null, mode: 'soft', toleranceSeconds: 0, actions: [], enabled: true })
)
$('ev-cancel').addEventListener('click', closeEvForm)

function closeEvForm() {
  evDraft = null
  $('ev-form').hidden = true
}

async function openEvForm(d) {
  evDraft = d
  const f = $('ev-form')
  $('ev-form-title').textContent = d.id ? 'Modifica evento' : 'Nuovo evento'
  $('ev-form-error').hidden = true
  f.label.value = d.label
  const hourly = d.time.startsWith('*')
  f.repeat.value = hourly ? 'hourly' : d.repeatMinutes > 0 ? 'every' : 'once'
  f.time.value = hourly ? '' : d.time
  f.minute.value = hourly ? Number(d.time.slice(2)) : 0
  f.repeatMinutes.value = d.repeatMinutes > 0 ? d.repeatMinutes : 30
  f.untilTime.value = d.untilTime || ''
  f.validFrom.value = d.validFrom || ''
  f.validTo.value = d.validTo || ''
  f.mode.value = d.mode
  f.toleranceSeconds.value = d.toleranceSeconds
  f.enabled.checked = d.enabled
  $('ev-days').replaceChildren(
    ...EV_DAY_ORDER.map((n) => {
      const l = el('label', 'check')
      const c = Object.assign(el('input'), { type: 'checkbox', value: String(n), checked: d.days.includes(n) })
      l.append(c, EV_DAYS[n])
      return l
    })
  )
  evShowWhen()
  f.hidden = false
  drawEvActions()
  f.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // programmi del server, per le repliche
  if (d.actions.some((a) => a.type === 'replay') || !evPrograms.length) {
    api('/api/programmi')
      .then((s) => {
        evPrograms = s.programs
        if (evDraft === d) drawEvActions()
      })
      .catch(() => {})
  }
}

function evShowWhen() {
  const f = $('ev-form')
  const r = f.repeat.value
  f.querySelector('.ev-time').hidden = r === 'hourly'
  f.querySelector('.ev-minute').hidden = r !== 'hourly'
  for (const x of f.querySelectorAll('.ev-every')) x.hidden = r !== 'every'
  f.querySelector('.ev-tol').hidden = f.mode.value !== 'soft'
}
$('ev-form').repeat.addEventListener('change', evShowWhen)
$('ev-form').mode.addEventListener('change', evShowWhen)

/** Campo collegato a una proprietà dell'azione. */
function evField(label, input, set) {
  const l = el('label', null, label)
  input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', () => set(input))
  l.append(input)
  return l
}
function evInput(value, attrs = {}) {
  // "list" (suggerimenti) si imposta solo come attributo
  const { list, ...rest } = attrs
  const i = Object.assign(el('input'), rest, { value: value ?? '' })
  if (list) i.setAttribute('list', list)
  return i
}
function evSelect(options, value) {
  const s = el('select')
  s.replaceChildren(...options.map(([v, t]) => Object.assign(el('option', null, t), { value: v })))
  s.value = value
  return s
}
const evNum = (v) => (v === '' || v == null ? null : Number(v))

function drawEvActions() {
  const list = $('ev-actions')
  list.replaceChildren(
    ...evDraft.actions.map((a, n) => {
      const li = el('li', 'ev-action')
      const head = el('div', 'row')
      head.append(el('b', null, EV_ACTIONS[a.type] || a.type), el('span', 'spacer'))
      const move = (delta) => {
        const to = n + delta
        if (to < 0 || to >= evDraft.actions.length) return
        ;[evDraft.actions[n], evDraft.actions[to]] = [evDraft.actions[to], evDraft.actions[n]]
        drawEvActions()
      }
      head.append(
        button('↑', 'Sposta su', () => move(-1), 'small ghost'),
        button('↓', 'Sposta giù', () => move(1), 'small ghost'),
        button('✕', 'Togli', () => {
          evDraft.actions.splice(n, 1)
          drawEvActions()
        }, 'small ghost')
      )
      li.append(head, ...evActionFields(a))
      return li
    })
  )
  if (!evDraft.actions.length) list.append(el('li', 'hint', 'Nessuna azione: aggiungine almeno una.'))
}

function evActionFields(a) {
  switch (a.type) {
    case 'play': {
      const chosen = el('div', 'hint', evTrackText(a.trackId))
      const q = evInput('', { placeholder: 'Cerca titolo o artista nella libreria della regia' })
      const results = el('ul', 'list')
      const go = button('Cerca', null, async () => {
        try {
          const found = await send({ type: 'search', q: q.value })
          results.replaceChildren(
            ...found.slice(0, 20).map((t) => {
              const li = el('li')
              li.append(el('span', 't-main', `${t.artist ? `${t.artist} – ` : ''}${t.title}`), button('Scegli', null, () => {
                evTracks.set(t.id, t)
                a.trackId = t.id
                chosen.textContent = evTrackText(t.id)
                results.replaceChildren()
              }, 'small'))
              return li
            })
          )
          if (!found.length) results.replaceChildren(el('li', 'hint', 'Nessun brano trovato'))
        } catch (e) {
          notice(evError(e))
        }
      }, 'small')
      q.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), go.click()))
      const row = el('div', 'row')
      row.append(q, go)
      return [chosen, row, results]
    }
    case 'random':
      return [
        evField('Tipo', evSelect(Object.entries(EV_KIND), a.kind), (i) => (a.kind = i.value)),
        evField('Genere o categoria (vuoto = qualsiasi)', evInput(a.genre, { list: 'ev-genres' }), (i) => (a.genre = i.value)),
        evField('Cartella sul PC di regia (vuoto = tutta la libreria)', evInput(a.folder), (i) => (a.folder = i.value))
      ]
    case 'playlist':
      return [
        evField('File della playlist o cartella sul PC di regia', evInput(a.path, { placeholder: 'C:\\Musica\\sigle.m3u' }), (i) => (a.path = i.value)),
        evField('Dove', evSelect([['front', 'Subito'], ['append', 'In fondo alla coda'], ['replace', 'Sostituisce la coda']], a.placement), (i) => (a.placement = i.value))
      ]
    case 'stream':
      return [
        evField('Indirizzo (http:// o https://)', evInput(a.url, { type: 'url' }), (i) => (a.url = i.value)),
        evField('Per quanti minuti', evInput(a.minutes, { type: 'number', min: 1, max: 1440 }), (i) => (a.minutes = Number(i.value))),
        evField('Titolo', evInput(a.title), (i) => (a.title = i.value))
      ]
    case 'mode':
      return [evField('Modalità', evSelect([['auto', 'Automatico'], ['manual', 'Manuale']], a.mode), (i) => (a.mode = i.value))]
    case 'djMix':
      return [evField('Mix DJ', evSelect([['1', 'Acceso'], ['0', 'Spento']], a.on ? '1' : '0'), (i) => (a.on = i.value === '1'))]
    case 'voice':
      return [evField('Testo ({ora}, {brano}, {artista}, {radio}…)', Object.assign(el('textarea'), { value: a.text, rows: 2, maxLength: 3000 }), (i) => (a.text = i.value))]
    case 'news': {
      const opts = [['', '— scegli —'], ...(evInfo?.news ?? []).map((n) => [n.id, n.name])]
      return [
        evField('Fonte (impostazioni della regia → Notiziari)', evSelect(opts, a.sourceId), (i) => {
          a.sourceId = i.value
          a.title = i.selectedOptions[0]?.textContent || ''
        })
      ]
    }
    case 'replay': {
      const opts = [['', '— scegli —'], ...evPrograms.map((p) => [p.id, p.title])]
      if (a.programId && !evPrograms.some((p) => p.id === a.programId)) opts.push([a.programId, a.title || a.programId])
      return [
        evField("Programma (va in onda l'ultima puntata pubblicata)", evSelect(opts, a.programId), (i) => {
          a.programId = i.value
          a.title = i.selectedOptions[0]?.textContent || ''
        })
      ]
    }
    case 'rotation': {
      const box = el('div', 'ev-profile')
      const normal = Object.assign(el('input'), { type: 'checkbox', checked: !a.profile })
      const l = el('label', 'check')
      l.append(normal, 'Torna alla rotazione normale (tutta la musica)')
      const fields = el('div', 'ev-profile-fields')
      const drawProfile = () => {
        fields.hidden = !a.profile
        if (!a.profile) return fields.replaceChildren()
        const p = a.profile
        fields.replaceChildren(
          evField('Nome', evInput(p.name, { placeholder: 'Es. Musica tranquilla' }), (i) => (p.name = i.value)),
          evField('Generi o categorie (separati da virgola, vuoto = tutti)', evInput(p.genres.join(', '), { list: 'ev-genres' }), (i) => (p.genres = i.value.split(',').map((g) => g.trim()).filter(Boolean))),
          evField('Anni dal', evInput(p.yearFrom, { type: 'number', min: 1900, max: 2100 }), (i) => (p.yearFrom = evNum(i.value))),
          evField('Anni al', evInput(p.yearTo, { type: 'number', min: 1900, max: 2100 }), (i) => (p.yearTo = evNum(i.value))),
          evField('Energia da (1-10)', evInput(p.energyMin, { type: 'number', min: 1, max: 10 }), (i) => (p.energyMin = evNum(i.value))),
          evField('Energia a (1-10)', evInput(p.energyMax, { type: 'number', min: 1, max: 10 }), (i) => (p.energyMax = evNum(i.value))),
          evField('Stesso artista non prima di (minuti, vuoto = regola generale)', evInput(p.artistSeparationMinutes, { type: 'number', min: 0, max: 1440 }), (i) => (p.artistSeparationMinutes = evNum(i.value))),
          evField('Un jingle ogni quanti brani (vuoto = regola generale)', evInput(p.jingleEvery, { type: 'number', min: 0, max: 50 }), (i) => (p.jingleEvery = evNum(i.value)))
        )
      }
      normal.addEventListener('change', () => {
        a.profile = normal.checked ? null : evNewAction('rotation').profile
        drawProfile()
      })
      drawProfile()
      box.append(l, fields)
      return [box]
    }
    default:
      return []
  }
}

$('ev-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const f = ev.target
  const r = f.repeat.value
  const d = evDraft
  d.label = f.label.value.trim()
  if (r === 'hourly') {
    d.time = `*:${String(Math.max(0, Math.min(59, Number(f.minute.value) || 0))).padStart(2, '0')}`
    d.repeatMinutes = 0
    d.untilTime = null
  } else {
    d.time = f.time.value
    d.repeatMinutes = r === 'every' ? Number(f.repeatMinutes.value) || 0 : 0
    d.untilTime = r === 'every' && f.untilTime.value ? f.untilTime.value : null
  }
  d.days = [...$('ev-days').querySelectorAll('input:checked')].map((c) => Number(c.value))
  d.validFrom = f.validFrom.value || null
  d.validTo = f.validTo.value || null
  d.mode = f.mode.value
  d.toleranceSeconds = Number(f.toleranceSeconds.value) || 0
  d.enabled = f.enabled.checked
  try {
    await evSend({ type: 'eventSave', event: d })
    closeEvForm()
    notice('Evento salvato in regia')
  } catch (e) {
    $('ev-form-error').textContent = evError(e)
    $('ev-form-error').hidden = false
  }
})

// ---------- rotazioni con l'AI della regia ----------

let aiInfo = null
let aiPlan = null
let aiTimer = null

async function loadAi(quiet) {
  if (!evAdmin() || !studio) return
  try {
    drawAi(await send({ type: 'aiStatus' }))
  } catch (e) {
    if (!quiet) $('ai-status').textContent = evError(e)
  }
}

function drawAi(info) {
  aiInfo = info
  const j = info.job
  if (document.activeElement !== $('ai-text') && !$('ai-text').value) $('ai-text').value = info.description || ''
  const running = j.state === 'in_corso'
  $('ai-go').disabled = running || !info.installed || !studio
  $('ai-cancel').hidden = !(running || j.state === 'pronto' || j.state === 'errore')
  $('ai-badge').textContent = info.installed ? info.modelName : ''
  let st = ''
  if (!info.installed) st = "Il modello dell'AI non è ancora nella regia: scaricalo dalla regia (Eventi → Rotazioni con l'AI, circa 2,5 GB). Dopo si usa anche da qui."
  else if (running) st = `⏳ L'AI della regia sta preparando le fasce (chiesto da ${j.by || '?'} alle ${hhmm(j.startedAt)}). Su un PC lento può volerci qualche minuto: puoi chiudere la pagina, il risultato resta qui.`
  else if (j.state === 'errore') st = `Non riuscito: ${j.error}`
  else if (j.state === 'pronto') st = `Pronto${j.result.seconds ? ` in ${j.result.seconds} s` : ''}: controlla le fasce e crea gli eventi.`
  $('ai-status').textContent = st
  clearTimeout(aiTimer)
  if (running) aiTimer = setTimeout(() => !$('eventi').hidden && loadAi(true), 3000)
  // non si ridisegna mentre si sta correggendo una fascia
  const editing = $('ai-slots').contains(document.activeElement)
  if (j.state === 'pronto' && j.result && !editing) {
    aiPlan = structuredClone(j.result.plan)
    drawAiResult(j.result)
  }
  $('ai-result').hidden = j.state !== 'pronto'
}

function drawAiResult(r) {
  $('ai-warn').replaceChildren(...r.warnings.map((w) => el('li', 'hint', `⚠ ${w}`)))
  $('ai-slots').replaceChildren(
    ...aiPlan.slots.map((s, n) => {
      const li = el('li', 'ev-action')
      const head = el('div', 'row')
      const count = r.counts[n]
      head.append(el('b', null, s.name), el('span', 'spacer'), el('span', count < 30 ? 'error' : 'hint', `${count ?? '?'} brani su ${r.music}`))
      head.append(button('✕', 'Togli la fascia', () => {
        aiPlan.slots.splice(n, 1)
        drawAiResult({ ...r, counts: r.counts.filter((_, i) => i !== n) })
      }, 'small ghost'))
      const days = el('div', 'ev-days')
      for (const d of EV_DAY_ORDER) {
        const l = el('label', 'check')
        const c = Object.assign(el('input'), { type: 'checkbox', checked: s.days.includes(d) })
        c.addEventListener('change', () => (s.days = EV_DAY_ORDER.filter((x) => (x === d ? c.checked : s.days.includes(x)))))
        l.append(c, EV_DAYS[d])
        days.append(l)
      }
      const fields = el('div', 'ev-profile-fields')
      fields.append(
        evField('Nome', evInput(s.name, { maxLength: 40 }), (i) => (s.name = i.value)),
        evField('Dalle', evInput(s.start, { type: 'time' }), (i) => (s.start = i.value)),
        evField('Alle (prima dell\'inizio = passa la mezzanotte)', evInput(s.end, { type: 'time' }), (i) => (s.end = i.value)),
        evField('Generi (separati da virgola)', evInput(s.genres.join(', '), { list: 'ev-genres' }), (i) => (s.genres = i.value.split(',').map((g) => g.trim()).filter(Boolean))),
        evField('Anni dal', evInput(s.yearFrom, { type: 'number', min: 1900, max: 2100 }), (i) => (s.yearFrom = evNum(i.value))),
        evField('Anni al', evInput(s.yearTo, { type: 'number', min: 1900, max: 2100 }), (i) => (s.yearTo = evNum(i.value))),
        evField('Energia da (1-10)', evInput(s.energyMin, { type: 'number', min: 1, max: 10 }), (i) => (s.energyMin = evNum(i.value))),
        evField('Energia a (1-10)', evInput(s.energyMax, { type: 'number', min: 1, max: 10 }), (i) => (s.energyMax = evNum(i.value))),
        evField('Un jingle ogni quanti brani (vuoto = regola generale)', evInput(s.jingleEvery, { type: 'number', min: 0, max: 50 }), (i) => (s.jingleEvery = evNum(i.value)))
      )
      li.append(head, days, fields)
      return li
    })
  )
  if (!aiPlan.slots.length) $('ai-slots').append(el('li', 'hint', 'Nessuna fascia.'))
}

$('ai-go').addEventListener('click', async () => {
  try {
    drawAi(await send({ type: 'aiGenerate', description: $('ai-text').value }))
  } catch (e) {
    $('ai-status').textContent = evError(e)
  }
})
$('ai-cancel').addEventListener('click', () => send({ type: 'aiCancel' }).then(drawAi, (e) => notice(evError(e))))
$('ai-recalc').addEventListener('click', async () => {
  try {
    document.activeElement?.blur()
    drawAi(await send({ type: 'aiPreview', plan: aiPlan }))
  } catch (e) {
    notice(evError(e))
  }
})
$('ai-apply').addEventListener('click', async () => {
  if (!aiPlan?.slots.length) return
  if (!confirm(`Creare gli eventi per ${aiPlan.slots.length} ${aiPlan.slots.length === 1 ? 'fascia' : 'fasce'}?`)) return
  try {
    await evSend({ type: 'aiApply', plan: aiPlan, replace: $('ai-replace').checked })
    notice('Eventi creati in regia')
    loadAi(true)
  } catch (e) {
    notice(evError(e))
  }
})
