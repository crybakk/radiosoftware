// Pannello remoto: impostazioni del server (il file .env), solo per gli amministratori.
'use strict'

let imp = null
let impPoll = null

$('imp-btn').addEventListener('click', () => {
  $('menu').hidden = true
  for (const id of ['main', 'users', 'progs', 'stats', 'ann']) $(id).hidden = true
  $('imp').hidden = false
  loadImp()
})
$('imp-close').addEventListener('click', () => {
  $('imp').hidden = true
  $('main').hidden = false
})

async function loadImp() {
  $('imp-msg').textContent = ''
  try {
    drawImp(await api('/api/impostazioni'))
  } catch (e) {
    $('imp-groups').replaceChildren()
    $('imp-adv-fields').replaceChildren()
    showImpStatus(e.message, 'error')
  }
}

function impField(v) {
  const lab = el('label', v.tipo === 'sino' ? 'check' : null)
  let input
  if (v.tipo === 'sino') {
    input = el('input')
    input.type = 'checkbox'
    input.checked = v.valore === 'si'
    lab.append(input, ` ${v.etichetta}`)
  } else {
    lab.append(v.etichetta)
    if (v.tipo === 'scelta') {
      input = el('select')
      for (const o of v.opzioni) {
        const opt = el('option', null, o)
        opt.value = o
        input.append(opt)
      }
      // un valore scritto a mano nel file che non è tra le scelte: si mostra com'è, altrimenti salvando
      // qualsiasi altra cosa partirebbe un valore vuoto (e il salvataggio verrebbe rifiutato)
      if (!v.opzioni.includes(v.valore)) {
        const opt = el('option', null, v.valore)
        opt.value = v.valore
        input.append(opt)
      }
      input.value = v.valore
    } else {
      input = el('input')
      input.type = v.tipo === 'password' ? 'password' : v.tipo === 'numero' ? 'number' : 'text'
      if (v.tipo === 'numero') {
        input.step = 'any'
        if (v.min != null) input.min = v.min
        if (v.max != null) input.max = v.max
      }
      input.value = v.valore
      if (!v.vuoto && v.tipo !== 'password') input.required = true
      input.autocomplete = 'off'
      if (v.tipo === 'password') {
        input.autocomplete = 'new-password'
        input.placeholder = v.impostato ? 'impostata: lascia vuoto per non cambiarla' : 'non impostata'
      }
    }
    if (v.tipo === 'password') {
      const row = el('div', 'row imp-pass')
      const eye = button('👁', 'Mostra o nascondi quello che scrivi', () => {
        input.type = input.type === 'password' ? 'text' : 'password'
      }, 'small ghost')
      eye.type = 'button'
      row.append(input, eye)
      if (v.vuoto && v.impostato) {
        const clr = el('label', 'check')
        const cb = el('input')
        cb.type = 'checkbox'
        cb.dataset.svuota = v.chiave
        clr.append(cb, ' Cancella')
        row.append(clr)
      }
      lab.append(row)
    } else {
      lab.append(input)
    }
  }
  input.dataset.chiave = v.chiave
  if (!v.aiuto) return lab
  // il suggerimento sotto il campo (accanto a una casella si leggerebbe male)
  const box = el('div', 'imp-field')
  box.append(lab, el('span', 'hint', v.aiuto))
  return box
}

function drawImp(r) {
  imp = r
  const groups = new Map()
  for (const v of r.voci) {
    if (v.avanzato) continue
    if (!groups.has(v.gruppo)) groups.set(v.gruppo, [])
    groups.get(v.gruppo).push(v)
  }
  $('imp-groups').replaceChildren(
    ...[...groups].map(([name, voci]) => {
      const card = el('div', 'card prog-form')
      card.append(el('div', 'section-title', name), ...voci.map(impField))
      return card
    })
  )
  $('imp-adv').checked = false
  $('imp-adv-fields').replaceChildren(...r.voci.filter((v) => v.avanzato).map(impField))
  setAdvanced(false)
  drawImpState(r.stato)
}

function setAdvanced(on) {
  for (const i of $('imp-adv-fields').querySelectorAll('input, select, button')) i.disabled = !on
}

$('imp-adv').addEventListener('change', () => {
  if ($('imp-adv').checked && !confirm('Questi valori, se sbagliati, staccano la regia o il pannello. Vuoi davvero modificarli?')) {
    $('imp-adv').checked = false
  }
  setAdvanced($('imp-adv').checked)
})

/** Valori cambiati rispetto a quelli caricati (le password solo se scritte). */
function impChanges() {
  const valori = {}
  for (const input of $('imp-form').querySelectorAll('[data-chiave]')) {
    const v = imp.voci.find((x) => x.chiave === input.dataset.chiave)
    if (v.avanzato && !$('imp-adv').checked) continue
    const val = v.tipo === 'sino' ? (input.checked ? 'si' : 'no') : input.value.trim()
    if (v.tipo === 'password' ? val !== '' : val !== v.valore) valori[v.chiave] = val
  }
  const svuota = [...$('imp-form').querySelectorAll('[data-svuota]')].filter((c) => c.checked && !c.disabled).map((c) => c.dataset.svuota)
  for (const k of svuota) delete valori[k]
  return { valori, svuota }
}

$('imp-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const { valori, svuota } = impChanges()
  const keys = [...Object.keys(valori), ...svuota]
  if (!keys.length) {
    $('imp-msg').textContent = 'Non hai cambiato niente'
    return
  }
  const voci = keys.map((k) => imp.voci.find((x) => x.chiave === k))
  const parti = [...new Set(voci.flatMap((v) => v.parti))]
  let testo = `Cambi: ${voci.map((v) => `${v.gruppo}: ${v.etichetta}`).join(', ')}.\n\nRipartirà: ${parti.map((p) => imp.parti[p]).join(', ')}.`
  if (parti.includes('audio') || parti.includes('icecast')) testo += '\nLa radio resterà muta per qualche secondo.'
  if (parti.includes('pannello')) testo += '\nIl pannello si ricollegherà da solo.'
  if (!confirm(`${testo}\n\nSalvare e applicare adesso?`)) return
  const avanzate = voci.some((v) => v.avanzato)
  if (avanzate && !confirm('Hai cambiato valori avanzati: ricordati di cambiarli anche nella regia, sul router o nelle app delle esterne. Confermi?')) return
  $('imp-save').disabled = true
  try {
    const r = await api('/api/impostazioni', { method: 'POST', body: JSON.stringify({ valori, svuota, avanzate }) })
    drawImp(r)
    $('imp-msg').textContent = 'Salvato'
  } catch (err) {
    $('imp-msg').textContent = err.message
  } finally {
    $('imp-save').disabled = false
  }
})

function showImpStatus(text, kind = 'info') {
  const s = $('imp-status')
  s.textContent = text
  s.className = `banner ${kind}`
  s.hidden = !text
}

function impTime(iso) {
  return new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function drawImpState(st) {
  clearTimeout(impPoll)
  if (!st) return showImpStatus('')
  // "inCorso" manca solo con un servizio di controllo vecchio (prima dell'aggiornamento)
  const waiting = st.inCorso ?? (st.richiesta && (!st.esito || Date.parse(st.esito.quando) < Date.parse(st.richiesta)))
  if ((waiting && st.servizioAssente) || st.senzaRisposta) {
    showImpStatus(
      st.senzaRisposta
        ? 'Le impostazioni sono salvate ma il server non ha detto se le ha applicate: il riavvio si è bloccato o è finito con un errore. Controlla sul server con "journalctl -u radio-ponte-impostazioni".'
        : 'Le impostazioni sono salvate ma il server non le ha ancora applicate: il servizio di riavvio non risponde. Rilancia una volta installa-server.sh sul server.',
      'error'
    )
    const again = button('Riprova', '', async () => {
      try {
        drawImpState((await api('/api/impostazioni/applica', { method: 'POST' })).stato)
      } catch (e) {
        $('imp-msg').textContent = e.message
      }
    }, 'small')
    $('imp-status').append(' ', again)
  } else if (waiting) {
    showImpStatus('Applico le impostazioni: il server sta ripartendo nelle parti che servono…')
  } else if (st.esito) {
    showImpStatus(`${st.esito.ok ? '✓' : '✗'} ${st.esito.messaggio} (${impTime(st.esito.quando)})`, st.esito.ok ? 'info' : 'error')
  } else {
    showImpStatus('')
  }
  // mentre il server riparte il pannello può non rispondere per qualche secondo: si riprova
  if (waiting && !st.senzaRisposta && !$('imp').hidden) {
    impPoll = setTimeout(async () => {
      try {
        drawImpState((await api('/api/impostazioni')).stato)
      } catch {
        drawImpState(st)
      }
    }, 3000)
  }
}
