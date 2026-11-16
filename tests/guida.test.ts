/** La guida d'uso (docs/GUIDA.md) deve restare coerente: ogni ancora e ogni immagine citata esiste. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { headings, renderMarkdown } from '../ponte/controllo/src/guidaMarkdown.ts'

const DOCS = join(import.meta.dirname, '..', 'docs')
const md = readFileSync(join(DOCS, 'GUIDA.md'), 'utf8')

describe('docs/GUIDA.md', () => {
  it('ogni link interno porta a un titolo che esiste', () => {
    const ids = new Set(headings(md).map((h) => h.id))
    const links = [...renderMarkdown(md).matchAll(/href="#([^"]+)"/g)].map((m) => m[1])
    expect(links.length).toBeGreaterThan(10)
    expect(links.filter((l) => !ids.has(decodeURIComponent(l)))).toEqual([])
  })

  it('ogni immagine citata è nella cartella docs/immagini', () => {
    const imgs = [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1])
    expect(imgs.every((i) => i.startsWith('immagini/'))).toBe(true)
    expect(imgs.filter((i) => !existsSync(join(DOCS, i)))).toEqual([])
  })

  it("ha l'indice (il pannello ci torna con il tasto in alto)", () => {
    expect(headings(md).some((h) => h.id === 'indice')).toBe(true)
  })
})
