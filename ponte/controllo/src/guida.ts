/**
 * Guida d'uso dentro il pannello: GET /guida mostra docs/GUIDA.md come pagina, GET /guida/immagini/<nome>.png
 * gli screenshot. Solo per chi è entrato nel pannello (/dashboard).
 * Sul server la guida sta in /opt/radio-ponte/guida (la copia installa-server.sh), montata in /app/guida.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderMarkdown } from './guidaMarkdown.ts'

/** Dove si trova la guida: la cartella montata nel contenitore, oppure docs/ del repository (prove in locale). */
export function findGuideDir(appDir: string, override = ''): string | null {
  const candidates = override ? [override] : [join(appDir, 'guida'), join(appDir, '..', '..', 'docs')]
  return candidates.find((d) => existsSync(join(d, 'GUIDA.md'))) ?? null
}

/** Nome di un'immagine della guida accettato nell'indirizzo (niente cartelle, solo png/jpg). */
export function guideImageName(path: string): string | null {
  const m = /^\/guida\/immagini\/([\w.-]+\.(png|jpe?g))$/.exec(path)
  return m && !m[1].startsWith('.') ? m[1] : null
}

const REPO = 'https://github.com/crybakk/radiosoftware/blob/main/docs/'

export async function guidePage(dir: string | null): Promise<string> {
  const md = dir ? await readFile(join(dir, 'GUIDA.md'), 'utf8').catch(() => null) : null
  const body = md
    ? renderMarkdown(md, {
        image: (src) => (src.startsWith('immagini/') ? `/guida/${src}` : src),
        // i link ad altri file del repository (es. ../ponte/README.md) si aprono su GitHub
        link: (href) => new URL(href, REPO).toString()
      })
    : '<p>La guida non è installata su questo server: rilancia <code>installa-server.sh</code> dalla cartella del programma.</p>'
  return `<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111418" />
    <title>Guida</title>
    <link rel="stylesheet" href="/guida.css" />
  </head>
  <body>
    <header class="guida-top"><a href="/dashboard" class="indietro">← Torna al pannello</a><a href="#indice" class="su">Indice</a></header>
    <article class="guida">${body}</article>
  </body>
</html>`
}
