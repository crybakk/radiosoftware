// Scrive la descrizione (note) di una release: cosa cambia nella regia e nel server, in italiano.
// Uso: node scripts/note-release.mjs <versione nuova>   (dalla cartella del repository, con tutta la storia git)
//
// - Quale programma cambia lo decidono i file cambiati dall'ultima release (tag v* più alto e minore della
//   versione nuova): codice della regia (src/, anche i moduli di ponte/controllo/src che la regia usa) e codice
//   del server (ponte/). Prove e documentazione non contano.
// - Le novità sono i file aggiunti in novita/ da allora (uno per ogni modifica, vedi novita/LEGGIMI.md).
// - In cima c'è un commento nascosto <!-- componenti: {...} --> che regia e server leggono
//   (ponte/controllo/src/novita.ts) per non proporre un aggiornamento che non li riguarda.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

const SEMPLICE = /^(\d+)\.(\d+)\.(\d+)$/

function confronta(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** Tag della release precedente: il v<versione> più alto e minore della versione nuova, o null. */
export function tagPrecedente(versione, tag) {
  let max = null
  for (const t of tag) {
    const v = t.replace(/^v/, '')
    if (!SEMPLICE.test(v) || confronta(v, versione) >= 0) continue
    if (!max || confronta(v, max) > 0) max = v
  }
  return max ? `v${max}` : null
}

const PROVA = /(\.test\.tsx?$|^tests\/|^ponte\/controllo\/prove\/)/

/**
 * Quali programmi cambiano, dai file cambiati.
 * `usatiDallaRegia` = file di ponte/ che la regia include (es. ponte/controllo/src/novita.ts).
 */
export function programmiCambiati(file, usatiDallaRegia) {
  let regia = false
  let server = false
  for (const f of file) {
    if (PROVA.test(f) || f.endsWith('.md')) continue
    if (
      f.startsWith('src/') ||
      f.startsWith('build-resources/') ||
      ['package.json', 'package-lock.json', 'electron.vite.config.ts'].includes(f) ||
      usatiDallaRegia.has(f)
    )
      regia = true
    if (f.startsWith('ponte/')) server = true
  }
  return { regia, server }
}

/** File di ponte/ che la regia include (direttamente o attraverso altri file di ponte/). */
export function fileUsatiDallaRegia(radice) {
  const usati = new Set()
  const daGuardare = []
  const IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  const elenca = (dir) => {
    for (const nome of readdirSync(join(radice, dir))) {
      const rel = posix.join(dir, nome)
      if (statSync(join(radice, rel)).isDirectory()) elenca(rel)
      else if (/\.(ts|tsx|js|mjs)$/.test(nome)) daGuardare.push(rel)
    }
  }
  elenca('src')
  while (daGuardare.length) {
    const f = daGuardare.pop()
    const testo = readFileSync(join(radice, f), 'utf8')
    for (const m of testo.matchAll(IMPORT)) {
      if (!m[1].startsWith('.')) continue
      const dest = posix.normalize(posix.join(posix.dirname(f), m[1]))
      if (dest.startsWith('ponte/') && !usati.has(dest)) {
        usati.add(dest)
        daGuardare.push(dest)
      }
    }
  }
  return usati
}

/** Punti dell'elenco sotto i titoli "Regia" e "Server" di un file di novità (markdown così com'è). */
export function leggiFrammento(testo) {
  const out = { regia: [], server: [] }
  let sezione = null
  let voce = null
  const chiudi = () => {
    if (sezione && voce) out[sezione].push(voce.join('\n'))
    voce = null
  }
  for (const riga of testo.split(/\r?\n/)) {
    const titolo = /^#{1,4}\s+(.+)$/.exec(riga)
    if (titolo) {
      chiudi()
      const t = titolo[1].trim().toLowerCase()
      sezione = t.startsWith('regia') ? 'regia' : t.startsWith('server') || t.startsWith('ponte') ? 'server' : null
      continue
    }
    if (!sezione) continue
    if (/^\s{0,3}[-*]\s+\S/.test(riga)) {
      chiudi()
      voce = [`- ${riga.replace(/^\s{0,3}[-*]\s+/, '').trimEnd()}`]
    } else if (riga.trim() === '') chiudi()
    else if (voce && /^\s+\S/.test(riga)) voce.push(`  ${riga.trim()}`)
  }
  chiudi()
  return out
}

/** Testo della release. `cambiati` = programmi cambiati nel codice; `frammenti` = testi dei file di novità. */
export function componiNote(cambiati, frammenti) {
  const voci = { regia: [], server: [] }
  for (const f of frammenti) {
    const n = leggiFrammento(f)
    voci.regia.push(...n.regia)
    voci.server.push(...n.server)
  }
  // chi scrive le novità può segnare un programma anche se il codice non cambia (es. solo la guida)
  const regia = cambiati.regia || voci.regia.length > 0
  const server = cambiati.server || voci.server.length > 0
  const righe = [`<!-- componenti: ${JSON.stringify({ regia, server })} -->`, '']
  if (regia && server) righe.push('Questa versione aggiorna **la regia e il server**.')
  else if (regia) righe.push('Questa versione aggiorna **solo la regia**: il server non ha bisogno di aggiornarsi.')
  else if (server) righe.push('Questa versione aggiorna **solo il server**: la regia non ha bisogno di aggiornarsi.')
  else righe.push('Questa versione non cambia i programmi (solo prove o documentazione): non serve aggiornare niente.')
  for (const [chi, titolo, attivo] of [
    ['regia', 'Regia', regia],
    ['server', 'Server', server]
  ]) {
    if (!attivo) continue
    righe.push('', `### ${titolo}`, '')
    righe.push(...(voci[chi].length ? voci[chi] : ['- Correzioni e miglioramenti interni.']))
  }
  return righe.join('\n') + '\n'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const versione = process.argv[2]
  if (!SEMPLICE.test(versione ?? '')) throw new Error('Uso: node scripts/note-release.mjs <versione>')
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean)
  const prec = tagPrecedente(versione, git('tag', '-l', 'v*'))
  const cambiati = prec ? git('diff', '--name-only', prec, 'HEAD') : ['src/', 'ponte/']
  const nuovi = (prec ? git('diff', '--name-only', '--diff-filter=A', prec, 'HEAD', '--', 'novita') : git('ls-files', 'novita'))
    .filter((f) => f.endsWith('.md') && !/LEGGIMI\.md$/i.test(f))
    .sort()
  const testo = componiNote(
    programmiCambiati(cambiati, fileUsatiDallaRegia('.')),
    nuovi.map((f) => readFileSync(f, 'utf8'))
  )
  process.stderr.write(`release precedente: ${prec ?? 'nessuna'}; file di novità: ${nuovi.join(', ') || 'nessuno'}\n`)
  process.stdout.write(testo)
}
