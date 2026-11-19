import { describe, expect, it } from 'vitest'
// @ts-expect-error script JavaScript senza tipi
import { componiNote, fileUsatiDallaRegia, leggiFrammento, programmiCambiati, tagPrecedente } from '../scripts/note-release.mjs'
import { leggiRelease } from '../ponte/controllo/src/novita.ts'

describe('note delle release', () => {
  it('trova la release precedente', () => {
    expect(tagPrecedente('0.1.11', ['v0.1.9', 'v0.1.10', 'v0.1.12', 'prova'])).toBe('v0.1.10')
    expect(tagPrecedente('0.1.0', ['v0.1.0'])).toBeNull()
  })

  it('capisce quale programma cambia dai file', () => {
    const usati = fileUsatiDallaRegia('.')
    // moduli del server che la regia include
    expect(usati.has('ponte/controllo/src/novita.ts')).toBe(true)
    expect(usati.has('ponte/controllo/src/guidaMarkdown.ts')).toBe(true)
    expect(usati.has('ponte/controllo/src/server.ts')).toBe(false)
    expect(programmiCambiati(['ponte/controllo/src/server.ts', 'tests/x.test.ts'], usati)).toEqual({ regia: false, server: true })
    expect(programmiCambiati(['src/main/index.ts', 'docs/GUIDA.md'], usati)).toEqual({ regia: true, server: false })
    expect(programmiCambiati(['ponte/controllo/src/novita.ts'], usati)).toEqual({ regia: true, server: true })
    expect(programmiCambiati(['ponte/controllo/src/hls.test.ts', 'README.md', '.github/workflows/build.yml'], usati)).toEqual({ regia: false, server: false })
  })

  it('legge i file di novità', () => {
    expect(leggiFrammento('## Regia\n\n- Uno\n  continua\n- Due\n\n## Altro\n- no\n## Server (ponte)\n* Tre\n')).toEqual({
      regia: ['- Uno\n  continua', '- Due'],
      server: ['- Tre']
    })
  })

  it('scrive note che regia e server sanno leggere', () => {
    const testo = componiNote({ regia: false, server: true }, ['## Server\n- Novità del server\n'])
    expect(testo).toContain('solo il server')
    const r = leggiRelease({ tag_name: 'v0.1.11', body: testo, assets: [] })
    expect(r).toMatchObject({ regia: false, server: true, novitaServer: ['Novità del server'], novitaRegia: [] })
    // programma cambiato senza novità scritte; sezione nelle novità che segna anche l'altro programma
    const t2 = componiNote({ regia: true, server: false }, ['## Server\n- Guida del pannello rifatta\n'])
    expect(leggiRelease({ tag_name: 'v0.1.12', body: t2 })).toMatchObject({
      regia: true,
      server: true,
      novitaRegia: ['Correzioni e miglioramenti interni.'],
      novitaServer: ['Guida del pannello rifatta']
    })
    expect(componiNote({ regia: false, server: false }, [])).toContain('non serve aggiornare niente')
  })
})
