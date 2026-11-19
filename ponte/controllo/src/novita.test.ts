import { describe, expect, it } from 'vitest'
import { leggiNote, leggiRelease, valuta } from './novita.ts'

const nuova = (v: string, regia: boolean, server: boolean, corpo = '') => ({
  tag_name: `v${v}`,
  draft: false,
  body: `<!-- componenti: ${JSON.stringify({ regia, server })} -->\n\nQuesta versione...\n${corpo}`,
  assets: [{ name: `RadioPonte-server-${v}.zip` }, { name: 'latest.yml' }]
})
const vecchia = (v: string, titolo: string) => ({
  tag_name: `v${v}`,
  body: `## What's Changed\n* ${titolo} by @crybakk in https://github.com/crybakk/radiosoftware/pull/4\n\n**Full Changelog**: https://x`,
  assets: [{ name: `RadioPonte-server-${v}.zip` }, { name: 'latest.yml' }]
})

describe('novità delle release', () => {
  it('legge le sezioni Regia e Server, con i punti su più righe e senza markdown', () => {
    const n = leggiNote(
      '<!-- componenti: {"regia":true,"server":false} -->\n### Regia\n\n- Uno **grassetto** e `codice`\n  che continua\n- Due [link](http://x)\n\n### Server\n\n- Tre\n'
    )
    expect(n.componenti).toEqual({ regia: true, server: false })
    expect(n.regia).toEqual(['Uno grassetto e codice che continua', 'Due link'])
    expect(n.server).toEqual(['Tre'])
  })

  it('le release vecchie valgono per tutti e due, con i titoli delle PR', () => {
    const r = leggiRelease(vecchia('0.1.9', 'Pannello: schede di benvenuto'))
    expect(r).toMatchObject({ versione: '0.1.9', regia: true, server: true, novitaRegia: ['Pannello: schede di benvenuto'] })
    expect(leggiRelease({ tag_name: 'v0.2.0', draft: true })).toBeNull()
    expect(leggiRelease({ tag_name: 'prova' })).toBeNull()
  })

  it('la regia non si aggiorna per versioni che cambiano solo il server', () => {
    const rel = [nuova('0.1.12', false, true, '### Server\n- Solo server'), nuova('0.1.11', true, false, '### Regia\n- Novità regia')]
    expect(valuta(rel, '0.1.11', 'regia')).toEqual({ ultima: '0.1.12', daAggiornare: false, novita: [] })
    expect(valuta(rel, '0.1.11', 'server')).toEqual({ ultima: '0.1.12', daAggiornare: true, novita: [{ versione: '0.1.12', novita: ['Solo server'] }] })
    // dalla 0.1.10 la regia ha la 0.1.11 da prendere (e installa l'ultima, che la contiene)
    expect(valuta(rel, '0.1.10', 'regia')).toEqual({ ultima: '0.1.12', daAggiornare: true, novita: [{ versione: '0.1.11', novita: ['Novità regia'] }] })
  })

  it('raccoglie le novità di tutte le versioni saltate, dalla più recente', () => {
    const rel = [vecchia('0.1.10', 'Vecchia'), nuova('0.1.11', true, true), nuova('0.1.12', false, true, '### Server\n- Nuovo')]
    const v = valuta(rel, '0.1.9', 'server')
    expect(v.novita.map((n) => n.versione)).toEqual(['0.1.12', '0.1.11', '0.1.10'])
    expect(v.novita[1].novita).toEqual(['Correzioni e miglioramenti interni.'])
    expect(v.novita[2].novita).toEqual(['Vecchia'])
    // versione installata sconosciuta: si aggiorna
    expect(valuta(rel, '', 'server').daAggiornare).toBe(true)
  })

  it('il server conta solo le release con il suo ZIP', () => {
    const senzaZip = { ...nuova('0.1.13', true, true), assets: [{ name: 'latest.yml' }] }
    expect(valuta([nuova('0.1.12', true, true), senzaZip], '0.1.12', 'server')).toMatchObject({ ultima: '0.1.12', daAggiornare: false })
    expect(valuta([nuova('0.1.12', true, true), senzaZip], '0.1.12', 'regia')).toMatchObject({ ultima: '0.1.13', daAggiornare: true })
  })
})
