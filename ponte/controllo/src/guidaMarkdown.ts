/**
 * Trasforma la guida (docs/GUIDA.md) in HTML, per mostrarla dentro la regia e nel pannello del ponte.
 * Copre solo il Markdown usato nella guida: titoli, paragrafi, elenchi (anche annidati), tabelle, immagini,
 * link, grassetto, corsivo, codice, righe orizzontali e citazioni. Tutto il testo viene "escapato":
 * nella guida non può finire HTML vero.
 * Usato sia dal servizio di controllo (Node) sia dalla regia (Vite): niente dipendenze.
 */

export interface RenderOptions {
  /** Indirizzo vero di un'immagine scritta nella guida (es. "immagini/regia-in-onda.png"). */
  image?: (src: string) => string
  /** Indirizzo vero di un link relativo (es. "../ponte/README.md"); i link "#…" e http(s) restano come sono. */
  link?: (href: string) => string
}

export interface Heading {
  level: number
  text: string
  id: string
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Ancora di un titolo come la fa GitHub: minuscole, via la punteggiatura, spazi → trattini. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*`_]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

function safeHref(href: string, opts: RenderOptions): string | null {
  const h = href.trim()
  if (h.startsWith('#')) return h
  if (/^(https?:|mailto:)/i.test(h)) return h
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null // javascript:, data:, ecc.
  return opts.link ? opts.link(h) : h
}

function safeImage(src: string, opts: RenderOptions): string | null {
  const s = src.trim()
  if (/^https?:/i.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || s.includes('..')) return null
  return opts.image ? opts.image(s) : s
}

/** Testo dentro una riga: codice, immagini, link, grassetto, corsivo. */
export function renderInline(text: string, opts: RenderOptions = {}): string {
  const codes: string[] = []
  // il codice va protetto prima di tutto il resto
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = esc(s)
  // le parentesi sono già "escapate" solo per < > & ": i link si cercano sul testo escapato
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, src: string) => {
    const url = safeImage(unesc(src), opts)
    return url ? `<img src="${esc(url)}" alt="${alt}" loading="lazy" />` : alt
  })
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
    const url = safeHref(unesc(href), opts)
    if (!url) return label
    const ext = /^(https?:|mailto:)/i.test(url)
    return `<a href="${esc(url)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`
  })
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)])
}

function unesc(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/
const isTableSep = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)
const splitRow = (l: string): string[] => {
  let t = l.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  // "\|" dentro una cella resta una barra
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

interface Item {
  indent: number
  ordered: boolean
  start: number
  text: string
  /** testo che continua la voce dopo il suo sottoelenco */
  tail?: string
}

function renderList(items: Item[], opts: RenderOptions): string {
  let out = ''
  let i = 0
  while (i < items.length) {
    const first = items[i]
    const ordered = first.ordered
    out += ordered ? (first.start !== 1 ? `<ol start="${first.start}">` : '<ol>') : '<ul>'
    while (i < items.length && items[i].indent === first.indent && items[i].ordered === ordered) {
      const it = items[i]
      i++
      // figli: le voci successive più rientrate
      const kids: Item[] = []
      while (i < items.length && items[i].indent > first.indent) kids.push(items[i++])
      const tail = it.tail ? `<p>${renderInline(it.tail, opts)}</p>` : ''
      out += `<li>${renderInline(it.text, opts)}${kids.length ? renderList(kids, opts) : ''}${tail}</li>`
    }
    // una voce di tipo diverso (o meno rientrata) apre un nuovo elenco
    out += ordered ? '</ol>' : '</ul>'
  }
  return out
}

/** Tutti i titoli della guida, con l'ancora (per l'indice). */
export function headings(md: string): Heading[] {
  const seen = new Map<string, number>()
  const out: Heading[] = []
  let fence = false
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence
    if (fence) continue
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const base = slugify(m[2])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.push({ level: m[1].length, text: m[2], id: n ? `${base}-${n}` : base })
  }
  return out
}

export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  const lines = md.split(/\r?\n/)
  const ids = headings(md)
  let h = 0
  let out = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    // blocco di codice
    if (/^\s*```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++
      out += `<pre><code>${esc(body.join('\n'))}</code></pre>`
      continue
    }
    const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (hm) {
      const id = ids[h++]?.id ?? slugify(hm[2])
      const lv = hm[1].length
      out += `<h${lv} id="${esc(id)}">${renderInline(hm[2], opts)}</h${lv}>`
      i++
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out += '<hr />'
      i++
      continue
    }
    // tabella: riga con | seguita dalla riga dei trattini
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]))
      out +=
        '<div class="tabella"><table><thead><tr>' +
        head.map((c) => `<th>${renderInline(c, opts)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, k) => `<td>${renderInline(r[k] ?? '', opts)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>'
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out += `<blockquote>${renderMarkdown(body.join('\n'), opts)}</blockquote>`
      continue
    }
    if (LIST_RE.test(line)) {
      const items: Item[] = []
      while (i < lines.length) {
        const l = lines[i]
        const m = LIST_RE.exec(l)
        if (m) {
          const num = /^\d+/.exec(m[2])
          items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: !!num, start: num ? Number(num[0]) : 1, text: m[3] })
          i++
          continue
        }
        // riga che continua la voce precedente (rientrata), senza riga vuota in mezzo
        if (l.trim() && /^\s+/.test(l) && items.length) {
          // va alla voce più vicina meno rientrata della riga (non sempre all'ultima voce di un sottoelenco)
          const ind = /^\s*/.exec(l)![0].replace(/\t/g, '    ').length
          const last = items[items.length - 1]
          const target = [...items].reverse().find((x) => x.indent < ind) ?? last
          if (target === last) last.text += ' ' + l.trim()
          else target.tail = (target.tail ? target.tail + ' ' : '') + l.trim()
          i++
          continue
        }
        // riga vuota seguita da un'altra voce (o da una riga rientrata): stesso elenco
        if (!l.trim() && i + 1 < lines.length && (LIST_RE.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
          i++
          continue
        }
        break
      }
      // normalizza i rientri: il più piccolo è il livello 0
      const min = Math.min(...items.map((x) => x.indent))
      for (const x of items) x.indent -= min
      out += renderList(items, opts)
      continue
    }
    // paragrafo
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    )
      para.push(lines[i++].trim())
    if (para.length) out += `<p>${renderInline(para.join(' '), opts)}</p>`
    else i++
  }
  return out
}
