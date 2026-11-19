/**
 * Novità delle release, lette dalla descrizione delle release di GitHub (usato da regia e server).
 *
 * La descrizione la scrive la pubblicazione automatica (scripts/note-release.mjs) con:
 * - un commento nascosto `<!-- componenti: {"regia":true,"server":false} -->` che dice quale programma cambia;
 * - le sezioni `### Regia` e `### Server` con l'elenco delle novità in italiano.
 * Così chi aggiorna vede cosa è stato fatto, e un programma non si aggiorna per una versione che non lo tocca.
 * Le release vecchie, senza il commento, valgono per tutti e due, con i titoli delle PR come novità.
 */

export type Programma = 'regia' | 'server'

const VERSIONE = /^\d+\.\d+\.\d+$/

/** Confronta due versioni a.b.c: negativo se a < b. */
export function confrontaVersioni(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

export interface InfoRelease {
  versione: string
  regia: boolean
  server: boolean
  novitaRegia: string[]
  novitaServer: string[]
  assets: string[]
}

/** Toglie la formattazione markdown più comune: il pannello e la regia mostrano testo semplice. */
function testoSemplice(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Legge le sezioni Regia/Server della descrizione: un elemento per ogni punto dell'elenco. */
export function leggiNote(testo: string): { regia: string[]; server: string[]; componenti: { regia: boolean; server: boolean } | null } {
  const out = { regia: [] as string[], server: [] as string[], componenti: null as { regia: boolean; server: boolean } | null }
  const m = /<!--\s*componenti:\s*(\{[^}]*\})\s*-->/.exec(testo)
  if (m) {
    try {
      const c = JSON.parse(m[1]) as { regia?: unknown; server?: unknown }
      out.componenti = { regia: c.regia === true, server: c.server === true }
    } catch {
      out.componenti = null
    }
  }
  let sezione: Programma | null = null
  let voce: string[] | null = null
  const chiudi = (): void => {
    if (sezione && voce) {
      const t = testoSemplice(voce.join(' '))
      if (t) out[sezione].push(t)
    }
    voce = null
  }
  for (const riga of testo.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const titolo = /^#{1,4}\s+(.+)$/.exec(riga)
    if (titolo) {
      chiudi()
      const t = titolo[1].trim().toLowerCase()
      sezione = t.startsWith('regia') ? 'regia' : t.startsWith('server') || t.startsWith('ponte') ? 'server' : null
      continue
    }
    if (!sezione) continue
    const punto = /^\s{0,3}[-*]\s+(.*)$/.exec(riga)
    if (punto) {
      chiudi()
      voce = [punto[1]]
    } else if (riga.trim() === '') {
      chiudi()
    } else if (voce && /^\s+\S/.test(riga)) {
      voce.push(riga.trim())
    }
  }
  chiudi()
  return out
}

/** Release vecchie (note generate da GitHub): i titoli delle PR, senza "by @utente in https://…". */
function titoliPr(testo: string): string[] {
  const titoli: string[] = []
  for (const riga of testo.split(/\r?\n/)) {
    const m = /^\s*\*\s+(.+?)\s+by\s+@\S+\s+in\s+https?:\/\/\S+\s*$/.exec(riga)
    if (m) titoli.push(testoSemplice(m[1]))
  }
  return titoli
}

/** Una release dell'API di GitHub, o null se è una bozza o ha un tag che non è una versione. */
export function leggiRelease(r: unknown): InfoRelease | null {
  if (!r || typeof r !== 'object') return null
  const rel = r as { tag_name?: unknown; draft?: unknown; body?: unknown; assets?: { name?: unknown }[] }
  if (rel.draft || typeof rel.tag_name !== 'string') return null
  const versione = rel.tag_name.replace(/^v/, '')
  if (!VERSIONE.test(versione)) return null
  const body = typeof rel.body === 'string' ? rel.body : ''
  const note = leggiNote(body)
  const assets = Array.isArray(rel.assets) ? rel.assets.map((a) => (typeof a?.name === 'string' ? a.name : '')).filter(Boolean) : []
  if (!note.componenti) {
    // release di prima di questa funzione: vale per tutti e due i programmi
    const vecchie = note.regia.length || note.server.length ? null : titoliPr(body)
    return {
      versione,
      regia: true,
      server: true,
      novitaRegia: vecchie ?? note.regia,
      novitaServer: vecchie ?? note.server,
      assets
    }
  }
  return { versione, ...note.componenti, novitaRegia: note.regia, novitaServer: note.server, assets }
}

export interface NovitaVersione {
  versione: string
  novita: string[]
}

export interface Valutazione {
  /** ultima versione pubblicata installabile da questo programma */
  ultima: string | null
  /** c'è almeno una versione più nuova di quella installata che cambia questo programma */
  daAggiornare: boolean
  /** novità per questo programma delle versioni più nuove di quella installata (dalla più recente) */
  novita: NovitaVersione[]
}

/** Il server si installa solo da release con il suo ZIP; la regia da release con l'installer. */
function installabile(r: InfoRelease, chi: Programma): boolean {
  if (chi === 'server') return r.assets.includes(`RadioPonte-server-${r.versione}.zip`)
  return r.assets.includes('latest.yml')
}

/**
 * Dice se un programma ha bisogno di aggiornarsi e cosa cambia, dall'elenco delle release di GitHub.
 * `attuale` vuoto (versione sconosciuta) = va aggiornato.
 */
export function valuta(release: unknown, attuale: string, chi: Programma): Valutazione {
  const elenco = (Array.isArray(release) ? release : []).map(leggiRelease).filter((r): r is InfoRelease => !!r)
  let ultima: string | null = null
  for (const r of elenco) if (installabile(r, chi) && (!ultima || confrontaVersioni(r.versione, ultima) > 0)) ultima = r.versione
  const nuove = elenco
    .filter((r) => ultima && confrontaVersioni(r.versione, ultima) <= 0 && (!VERSIONE.test(attuale) || confrontaVersioni(r.versione, attuale) > 0))
    .filter((r) => r[chi])
    .sort((a, b) => confrontaVersioni(b.versione, a.versione))
  return {
    ultima,
    daAggiornare: nuove.length > 0,
    novita: nuove.map((r) => {
      const n = chi === 'regia' ? r.novitaRegia : r.novitaServer
      return { versione: r.versione, novita: n.length ? n : ['Correzioni e miglioramenti interni.'] }
    })
  }
}
