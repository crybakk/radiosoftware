import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dentroCartella, paginaRegia } from '../src/core/finestraSicura'

describe('finestra della regia', () => {
  const file = join('/opt', 'Radio Regia', 'resources', 'renderer', 'index.html')
  it('accetta solo la propria pagina', () => {
    expect(paginaRegia(pathToFileURL(file).href, file)).toBe(true)
    expect(paginaRegia(pathToFileURL(file).href + '#/eventi', file)).toBe(true)
    expect(paginaRegia(pathToFileURL('/tmp/prova.html').href, file)).toBe(false)
    expect(paginaRegia('https://example.invalid/', file)).toBe(false)
    expect(paginaRegia('', file)).toBe(false)
  })
  it('in sviluppo accetta solo il server di sviluppo', () => {
    expect(paginaRegia('http://localhost:5173/', file, 'http://localhost:5173')).toBe(true)
    expect(paginaRegia('http://localhost:5174/', file, 'http://localhost:5173')).toBe(false)
    expect(paginaRegia(pathToFileURL(file).href, file, 'http://localhost:5173')).toBe(false)
  })
  it('controlla le cartelle dopo aver risolto ".."', () => {
    expect(dentroCartella('/dati/notiziari/gr.mp3', '/dati/notiziari')).toBe(true)
    expect(dentroCartella('/dati/notiziari/../radio.db', '/dati/notiziari')).toBe(false)
    expect(dentroCartella('/dati/notiziari-x/gr.mp3', '/dati/notiziari')).toBe(false)
    expect(dentroCartella('/dati/notiziari', '/dati/notiziari')).toBe(false)
  })
})
