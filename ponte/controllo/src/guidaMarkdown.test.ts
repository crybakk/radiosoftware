import { describe, expect, it } from 'vitest'
import { headings, renderInline, renderMarkdown, slugify } from './guidaMarkdown.ts'

describe('guida: Markdown', () => {
  it('fa le ancore come GitHub', () => {
    expect(slugify('11. Dirette esterne')).toBe('11-dirette-esterne')
    expect(slugify("Rotazioni con l'AI")).toBe('rotazioni-con-lai')
    expect(slugify('Discogs, Last.fm e AcoustID')).toBe('discogs-lastfm-e-acoustid')
    expect(slugify('Perché è così?')).toBe('perché-è-così')
    expect(headings('# A\n## Uno\n## Uno').map((h) => h.id)).toEqual(['a', 'uno', 'uno-1'])
  })

  it('titoli, paragrafi, grassetto, corsivo e codice', () => {
    const html = renderMarkdown('## 1. Prima\n\nPremi **PLAY** e *aspetta*.\nPoi `riavvia.sh`.')
    expect(html).toBe('<h2 id="1-prima">1. Prima</h2><p>Premi <strong>PLAY</strong> e <em>aspetta</em>. Poi <code>riavvia.sh</code>.</p>')
  })

  it('niente HTML vero e niente link pericolosi', () => {
    const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) ![y](data:image/png;base64,AA) ![z](../segreto.png)')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data:')
    expect(html).not.toContain('segreto')
    expect(html).toContain('&lt;script&gt;')
  })

  it('immagini e link passano dalle funzioni della pagina', () => {
    const html = renderInline('![Regia](immagini/a.png) [README](../ponte/README.md) [qui](#indice) [sito](https://x.it)', {
      image: (s) => '/guida/' + s,
      link: (h) => 'https://gh/' + h
    })
    expect(html).toContain('<img src="/guida/immagini/a.png" alt="Regia"')
    expect(html).toContain('<a href="https://gh/../ponte/README.md" target="_blank"')
    expect(html).toContain('<a href="#indice">qui</a>')
    expect(html).toContain('<a href="https://x.it" target="_blank" rel="noopener noreferrer">sito</a>')
  })

  it('elenchi numerati, puntati, annidati e su più righe', () => {
    const md = '1. Uno\n   continua\n2. Due\n    - a\n    - b\n3. Tre\n\n- x\n- y'
    expect(renderMarkdown(md)).toBe(
      '<ol><li>Uno continua</li><li>Due<ul><li>a</li><li>b</li></ul></li><li>Tre</li></ol><ul><li>x</li><li>y</li></ul>'
    )
    expect(renderMarkdown('4. Quattro\n5. Cinque')).toBe('<ol start="4"><li>Quattro</li><li>Cinque</li></ol>')
  })

  it('tabelle, anche con la barra dentro una cella', () => {
    const html = renderMarkdown('| Spia | Significato |\n|---|---|\n| verde | ok \\| bene |\n| gialla | |')
    expect(html).toBe(
      '<div class="tabella"><table><thead><tr><th>Spia</th><th>Significato</th></tr></thead><tbody>' +
        '<tr><td>verde</td><td>ok | bene</td></tr><tr><td>gialla</td><td></td></tr></tbody></table></div>'
    )
  })

  it('codice, citazioni e righe orizzontali', () => {
    expect(renderMarkdown('```\na < b\n```')).toBe('<pre><code>a &lt; b</code></pre>')
    expect(renderMarkdown('> **Nota:** ciao')).toBe('<blockquote><p><strong>Nota:</strong> ciao</p></blockquote>')
    expect(renderMarkdown('---')).toBe('<hr />')
  })
})

describe('guida: casi limite', () => {
  it('riga rientrata dopo un sottoelenco: resta nella voce principale, dopo il sottoelenco', () => {
    const md = '6. **Router**: inoltra\n    - TCP 80\n    - UDP 9020\n\n   Appena le porte arrivano, ok.\n7. Musica'
    expect(renderMarkdown(md)).toBe(
      '<ol start="6"><li><strong>Router</strong>: inoltra<ul><li>TCP 80</li><li>UDP 9020</li></ul><p>Appena le porte arrivano, ok.</p></li><li>Musica</li></ol>'
    )
  })

  it('titoli con accenti scritti in forma scomposta (NFD, es. file salvato su Mac): il link trova lo stesso il titolo', () => {
    const md = '## Perchè no\n\n[vai](#perchè-no)'
    const id = headings(md)[0].id
    expect(renderMarkdown(md)).toContain(`href="#${id}"`)
  })
})
