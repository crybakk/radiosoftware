// Pannello remoto: programmi e puntate on demand (registrazione automatica, revisione, pubblicazione, repliche).
'use strict'

const DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab']
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
let progs = null

function hms(s) {
  s = Math.max(0, Math.round(s || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
function parseHms(t) {
  const parts = String(t).trim().split(':').map(Number)
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN
  return parts.reduce((a, n) => a * 60 + n, 0)
}
function dayTime(ms) {
  return new Date(ms).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
function slotText(s) {
  const days = DAY_ORDER.filter((d) => s.days.includes(d)).map((d) => DAYS[d])
  return `${days.length === 7 ? 'tutti i giorni' : days.join(' ')} ${s.start}-${s.end}`
}
async function progApi(path, body) {
  return api(path, body ? { method: 'POST', body: JSON.stringify(body) } : {})
}

$('progs-btn').addEventListener('click', () => {
  $('menu').hidden = true
  $('main').hidden = true
  $('users').hidden = true
  $('stats').hidden = true
  $('ann').hidden = true
  $('imp').hidden = true
  $('eventi').hidden = true
  $('progs').hidden = false
  loadProgs()
})
$('progs-close').addEventListener('click', () => {
  $('progs').hidden = true
  $('main').hidden = false
})

async function loadProgs() {
  try {
    drawProgs(await progApi('/api/programmi'))
  } catch (e) {
    notice(e.message)
  }
}
setInterval(() => !$('progs').hidden && !progBusy() && loadProgs(), 30_000)

/** Non ridisegnare mentre si scrive o si ascolta. */
function progBusy() {
  const a = document.activeElement
  if (a && $('progs').contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return true
  return [...$('progs').querySelectorAll('audio')].some((x) => !x.paused)
}

function drawProgs(s) {
  progs = s
  const byId = Object.fromEntries(s.programs.map((p) => [p.id, p]))
  const rec = s.recording.map((r) => `${byId[r.programId]?.title ?? r.programId} (fino alle ${hhmm(new Date(r.to).toISOString())})`)
  $('progs-status').textContent = rec.length ? `● Si sta registrando: ${rec.join(', ')}.` : 'Nessuna registrazione in corso.'
  $('progs-status').className = rec.length ? 'rec' : 'hint'
  // gli ospiti del pannello (solo lettura) non vedono bozze né registrazioni in corso (il server non le manda)
  $('progs-status').hidden = !s.canEdit
  $('drafts-card').hidden = !s.canEdit
  const drafts = s.episodes.filter((e) => e.status === 'bozza' || e.status === 'registrazione')
  $('drafts').replaceChildren(...(drafts.length ? drafts.map((e) => draftItem(e, byId[e.programId])) : [el('li', 'hint', 'Nessuna puntata da rivedere.')]))
  $('drafts-badge').textContent = drafts.filter((e) => e.status === 'bozza').length ? `${drafts.filter((e) => e.status === 'bozza').length} da rivedere` : ''
  $('progs-list').replaceChildren(
    ...(s.programs.length ? s.programs.map((p) => programItem(p, s.episodes.filter((e) => e.programId === p.id && (e.status === 'pubblicata' || e.status === 'ritirata')))) : [el('li', 'hint', 'Nessun programma. Un amministratore li crea da qui.')])
  )
  $('prog-new').hidden = !s.canAdmin
  $('prog-settings').hidden = !s.canAdmin
  const f = $('prog-settings-form')
  if (document.activeElement?.form !== f) {
    f.station.value = s.settings.station
    f.marginMinutes.value = s.settings.marginMinutes
  }
  $('prog-api').textContent = `L'app trova i programmi su ${location.origin}/api/station/${s.settings.station}/public/podcasts, come su AzuraCast. Pagine per gli ascoltatori: ${location.origin}/ (la diretta) e ${location.origin}/podcast.html (le puntate)`
}

function draftItem(e, p) {
  const li = el('li', 'prog-item')
  const head = el('div', 'prog-head')
  const main = el('div', 't-main')
  main.append(el('div', 't-title', p ? p.title : e.programId))
  main.append(el('div', 't-artist', `${dayTime(e.recordedFrom)} · ${e.status === 'registrazione' ? 'registrazione in corso' : hms(e.length)}`))
  head.append(main)
  li.append(head)
  if (e.status === 'registrazione') return li
  const audio = el('audio')
  audio.controls = true
  audio.preload = 'metadata'
  audio.src = `/api/puntate/audio?id=${encodeURIComponent(e.id)}`
  li.append(audio)
  if (!progs.canEdit) return li
  const form = el('form', 'cut')
  const input = (name, value, ph, cls) => {
    const i = el('input', cls)
    i.name = name
    i.value = value
    i.placeholder = ph
    i.autocomplete = 'off'
    return i
  }
  const from = input('inizio', hms(0), 'Inizio (h:mm:ss)', 'time')
  const to = input('fine', hms(e.length), 'Fine (h:mm:ss)', 'time')
  const title = input('title', e.title, 'Titolo della puntata')
  const desc = el('textarea')
  desc.name = 'description'
  desc.rows = 2
  desc.placeholder = 'Descrizione (ospiti, argomenti...)'
  desc.value = e.description
  const fromBox = el('label', null, 'Inizio')
  fromBox.append(from, button('Inizio qui', 'Usa il punto che stai ascoltando', (ev) => { ev.preventDefault(); from.value = hms(audio.currentTime) }, 'small'))
  const toBox = el('label', null, 'Fine')
  toBox.append(to, button('Fine qui', 'Usa il punto che stai ascoltando', (ev) => { ev.preventDefault(); to.value = hms(audio.currentTime) }, 'small'))
  const listen = el('div', 'row')
  listen.append(
    button('▶ Ascolta l\'inizio', '', (ev) => { ev.preventDefault(); audio.currentTime = parseHms(from.value) || 0; void audio.play() }, 'small ghost'),
    button('▶ Ascolta la fine', 'Gli ultimi 15 secondi prima della fine', (ev) => { ev.preventDefault(); audio.currentTime = Math.max(0, (parseHms(to.value) || 0) - 15); void audio.play() }, 'small ghost')
  )
  // si ferma da solo alla fine scelta, per sentire dove taglia
  audio.addEventListener('timeupdate', () => {
    const end = parseHms(to.value)
    if (Number.isFinite(end) && audio.currentTime >= end && audio.currentTime < end + 1) audio.pause()
  })
  const row = el('div', 'row')
  row.append(el('button', 'primary', 'Pubblica'))
  row.append(
    button('Elimina', 'Cancella la registrazione', async (ev) => {
      ev.preventDefault()
      if (!confirm('Eliminare questa registrazione? Non si può recuperare.')) return
      try {
        drawProgs(await progApi('/api/puntate', { azione: 'elimina', id: e.id }))
      } catch (err) {
        notice(err.message)
      }
    }, 'ghost')
  )
  form.append(fromBox, toBox, listen, title, desc, row)
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const a = parseHms(from.value)
    const b = parseHms(to.value)
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return notice('Controlla inizio e fine (ore:minuti:secondi)')
    const btn = row.querySelector('button.primary')
    btn.disabled = true
    btn.textContent = 'Pubblico...'
    try {
      drawProgs(await progApi('/api/puntate', { azione: 'pubblica', id: e.id, inizio: a, fine: b, title: title.value, description: desc.value }))
      notice('Puntata pubblicata')
    } catch (err) {
      btn.disabled = false
      btn.textContent = 'Pubblica'
      notice(err.message)
    }
  })
  li.append(form)
  return li
}

function programItem(p, episodes) {
  const li = el('li', 'prog-item')
  const head = el('div', 'prog-head')
  const img = el('img')
  img.alt = ''
  if (p.art) img.src = `/api/station/${progs.settings.station}/public/podcast/${p.id}/art-${p.artUpdatedAt}.jpg`
  const main = el('div', 't-main')
  main.append(el('div', 't-title', p.title + (p.published ? '' : ' (nascosto)')))
  const info = [p.author, p.slots.map(slotText).join(', ') || 'nessuna fascia', p.record ? 'registrazione automatica' : 'non si registra']
  main.append(el('div', 't-artist', info.filter(Boolean).join(' · ')))
  head.append(img, main)
  if (progs.canAdmin) {
    const actions = el('div', 't-actions')
    const file = el('input')
    file.type = 'file'
    file.accept = 'image/png,image/jpeg'
    file.hidden = true
    file.addEventListener('change', async () => {
      const f = file.files[0]
      if (!f) return
      try {
        const r = await fetch(`/api/programmi/copertina?id=${encodeURIComponent(p.id)}`, { method: 'PUT', credentials: 'same-origin', body: f })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body.error || `errore ${r.status}`)
        drawProgs(body)
      } catch (err) {
        notice(err.message)
      }
    })
    actions.append(
      file,
      button('Copertina', 'Immagine quadrata PNG o JPG', () => file.click(), 'small'),
      button('Modifica', '', () => editProgram(p), 'small'),
      button('Elimina', '', async () => {
        if (!confirm(`Eliminare il programma "${p.title}" e tutte le sue puntate?`)) return
        try {
          drawProgs(await progApi('/api/programmi', { azione: 'elimina', id: p.id }))
        } catch (err) {
          notice(err.message)
        }
      }, 'small ghost')
    )
    head.append(actions)
  }
  li.append(head)
  if (episodes.length) {
    const ul = el('ul', 'list ep-list')
    for (const e of episodes) ul.append(episodeItem(e, p))
    li.append(ul)
  }
  return li
}

function episodeItem(e, p) {
  const li = el('li')
  const main = el('div', 't-main')
  main.append(el('div', 't-title', e.title + (e.status === 'ritirata' ? ' (ritirata)' : '')))
  main.append(el('div', 't-artist', `${dayTime(e.recordedFrom)} · ${hms(e.length)}`))
  li.append(main)
  const actions = el('div', 't-actions')
  const audio = el('audio')
  audio.preload = 'none'
  audio.src = `/api/puntate/audio?id=${encodeURIComponent(e.id)}`
  const play = button('▶', 'Ascolta', () => {
    if (audio.paused) void audio.play()
    else audio.pause()
  }, 'small')
  audio.addEventListener('play', () => (play.textContent = '⏸'))
  audio.addEventListener('pause', () => (play.textContent = '▶'))
  actions.append(audio, play)
  if (progs.canEdit) {
    const act = (azione, extra = {}) => async () => {
      try {
        drawProgs(await progApi('/api/puntate', { azione, id: e.id, ...extra }))
      } catch (err) {
        notice(err.message)
      }
    }
    if (e.status === 'pubblicata' && p.published) {
      actions.append(
        button('Replica', 'Manda in onda questa puntata dopo il brano in corso (regia)', async () => {
          if (!studio) return notice('La regia è scollegata: la replica si manda dalla regia')
          if (!confirm(`Mandare in onda "${e.title}" dopo il brano in corso?`)) return
          try {
            await send({ type: 'replay', programId: p.id, episodeId: e.id, where: 'next' })
            notice('Replica messa in coda nella regia')
          } catch (err) {
            notice(err.message)
          }
        }, 'small')
      )
    }
    actions.append(
      button('Modifica', 'Titolo e descrizione', () => {
        const title = prompt('Titolo della puntata', e.title)
        if (title == null) return
        const description = prompt('Descrizione', e.description)
        if (description == null) return
        void act('modifica', { title, description })()
      }, 'small'),
      e.status === 'pubblicata'
        ? button('Ritira', 'Toglie la puntata dalla pagina e dall\'app (il file resta)', act('ritira'), 'small ghost')
        : button('Ripubblica', '', act('ripubblica'), 'small ghost'),
      button('Elimina', '', () => confirm(`Eliminare "${e.title}"? Non si può recuperare.`) && void act('elimina')(), 'small ghost')
    )
  }
  li.append(actions)
  return li
}

// ---------- modulo del programma (amministratori) ----------

function slotRow(s) {
  const row = el('div', 'slot')
  const days = el('div', 'days')
  for (const d of DAY_ORDER) {
    const l = el('label', null, DAYS[d])
    const c = el('input')
    c.type = 'checkbox'
    c.value = String(d)
    c.checked = s.days.includes(d)
    l.prepend(c)
    days.append(l)
  }
  const time = (v) => {
    const i = el('input')
    i.type = 'time'
    i.value = v
    i.required = true
    return i
  }
  row.append(days, time(s.start), el('span', null, '→'), time(s.end), button('✕', 'Togli la fascia', (ev) => { ev.preventDefault(); row.remove() }, 'small ghost'))
  return row
}

function editProgram(p) {
  const f = $('prog-form')
  f.hidden = false
  $('prog-form-title').textContent = p ? `Modifica: ${p.title}` : 'Nuovo programma'
  f.pid.value = p?.id ?? ''
  f.title.value = p?.title ?? ''
  f.author.value = p?.author ?? ''
  f.description.value = p?.description ?? ''
  f.record.checked = p ? p.record : true
  f.published.checked = p ? p.published : true
  $('prog-slots').replaceChildren(...(p?.slots ?? [{ days: [1, 2, 3, 4, 5], start: '10:00', end: '11:00' }]).map(slotRow))
  f.scrollIntoView({ behavior: 'smooth' })
  f.title.focus()
}

$('prog-new').addEventListener('click', () => editProgram(null))
$('prog-cancel').addEventListener('click', () => ($('prog-form').hidden = true))
$('prog-slot-add').addEventListener('click', () => $('prog-slots').append(slotRow({ days: [], start: '10:00', end: '11:00' })))
$('prog-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const f = ev.target
  const slots = [...$('prog-slots').querySelectorAll('.slot')].map((row) => {
    const t = row.querySelectorAll('input[type=time]')
    return { days: [...row.querySelectorAll('input[type=checkbox]:checked')].map((c) => Number(c.value)), start: t[0].value, end: t[1].value }
  })
  try {
    drawProgs(
      await progApi('/api/programmi', {
        azione: 'salva',
        programma: { id: f.pid.value || undefined, title: f.title.value, author: f.author.value, description: f.description.value, record: f.record.checked, published: f.published.checked, slots }
      })
    )
    f.hidden = true
    notice('Programma salvato')
  } catch (err) {
    notice(err.message)
  }
})

$('prog-settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const f = ev.target
  try {
    drawProgs(await progApi('/api/programmi', { azione: 'impostazioni', station: f.station.value, marginMinutes: Number(f.marginMinutes.value) }))
    notice('Impostazioni salvate')
  } catch (err) {
    notice(err.message)
  }
})
