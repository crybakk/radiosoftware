import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aggiornaEnv, Impostazioni, leggiEnv, scriviValore, VOCI } from './impostazioni.ts'

const ESEMPIO = readFileSync(join(import.meta.dirname, '..', '..', '.env.esempio'), 'utf8')

function make(testo = ESEMPIO, now = () => Date.now()) {
  const d = mkdtempSync(join(tmpdir(), 'impostazioni-'))
  writeFileSync(join(d, '.env'), testo)
  return { imp: new Impostazioni(join(d, '.env'), d, now), dir: d, env: () => readFileSync(join(d, '.env'), 'utf8') }
}

describe('file .env', () => {
  it('legge valori con virgolette e commenti', () => {
    expect(leggiEnv("A=1\n# B=2\nC='x $y #z'\nD=\"a\\\"b\"\nE=valore # commento\nexport F=f\n")).toEqual({
      A: '1',
      C: 'x $y #z',
      D: 'a"b',
      E: 'valore',
      F: 'f'
    })
  })

  it('mette tra apici i valori con caratteri speciali', () => {
    expect(scriviValore('abc123/radio.mp3')).toBe('abc123/radio.mp3')
    expect(scriviValore('La mia radio')).toBe("'La mia radio'")
    expect(scriviValore('pa$$#word')).toBe("'pa$$#word'")
    expect(leggiEnv(`X=${scriviValore('pa$$ #word')}`).X).toBe('pa$$ #word')
  })

  it('cambia solo le righe giuste e conserva i commenti', () => {
    const prima = '# commento\nA=1\nB=2\n'
    expect(aggiornaEnv(prima, { B: '3', C: 'nuovo' })).toBe('# commento\nA=1\nB=3\nC=nuovo\n')
  })

  it('ogni voce del pannello esiste nel file di esempio (tranne la descrizione)', () => {
    const esempio = leggiEnv(ESEMPIO)
    const mancanti = VOCI.map((v) => v.chiave).filter((k) => !(k in esempio))
    expect(mancanti).toEqual(['DESCRIZIONE_RADIO'])
  })
})

describe('impostazioni dal pannello', () => {
  it('non manda le password al browser', () => {
    const { imp } = make('ESTERNA_PASSWORD=Xq7zz9pw\nNOME_RADIO=Prova\n')
    const v = imp.elenco()
    expect(v.find((x) => x.chiave === 'ESTERNA_PASSWORD')).toMatchObject({ valore: '', impostato: true })
    expect(v.find((x) => x.chiave === 'NOME_RADIO')!.valore).toBe('Prova')
    expect(v.find((x) => x.chiave === 'ICECAST_BITRATE')!.valore).toBe('128')
    expect(JSON.stringify(v)).not.toContain('Xq7zz9pw')
  })

  it('salva, dice cosa riparte e lascia la richiesta di applicare', () => {
    const { imp, env, dir } = make()
    const r = imp.salva({ NOME_RADIO: 'Radio Attiva', ESTERNA_PASSWORD: 'nuova$pw', TELEGRAM_CHAT_ID: '-100123' }, { avanzate: false })
    expect(r.cambiate.sort()).toEqual(['ESTERNA_PASSWORD', 'NOME_RADIO', 'TELEGRAM_CHAT_ID'])
    expect(r.parti.sort()).toEqual(['audio', 'icecast', 'pannello'])
    const e = leggiEnv(env())
    expect(e.NOME_RADIO).toBe('Radio Attiva')
    expect(e.ESTERNA_PASSWORD).toBe('nuova$pw')
    expect(env()).toContain("ESTERNA_PASSWORD='nuova$pw'")
    expect(env()).toContain('# --- Dirette esterne ---')
    imp.applica()
    expect(existsSync(join(dir, 'applica'))).toBe(true)
  })

  it('niente cambiato, niente da riavviare; password vuota = resta quella di prima', () => {
    const { imp, env } = make('ESTERNA_PASSWORD=vecchia\nNOME_RADIO=Uguale\n')
    expect(imp.salva({ NOME_RADIO: 'Uguale', ESTERNA_PASSWORD: '' }, { avanzate: false })).toEqual({ cambiate: [], parti: [] })
    expect(leggiEnv(env()).ESTERNA_PASSWORD).toBe('vecchia')
    imp.salva({}, { avanzate: false, svuota: ['ESTERNA_PASSWORD'] })
    expect(leggiEnv(env()).ESTERNA_PASSWORD).toBe('')
  })

  it('i valori avanzati si cambiano solo con la modifica avanzata', () => {
    const { imp, env } = make()
    expect(() => imp.salva({ SRT_PORT: '9001' }, { avanzate: false })).toThrow(/Modifica avanzata/)
    expect(leggiEnv(env()).SRT_PORT).toBe('9000')
    // lo stesso valore di prima non conta come cambio
    expect(imp.salva({ SRT_PORT: '9000' }, { avanzate: false }).cambiate).toEqual([])
    expect(imp.salva({ SRT_PORT: '9001' }, { avanzate: true }).parti).toEqual(['audio'])
  })

  it('rifiuta valori sbagliati senza toccare il file', () => {
    const { imp, env } = make()
    const prima = env()
    expect(() => imp.salva({ ICECAST_MAX_ASCOLTATORI: 'tanti' }, { avanzate: false })).toThrow(/numero/)
    expect(() => imp.salva({ ESTERNA_MOUNT: 'senza-barra' }, { avanzate: false })).toThrow(/\//)
    expect(() => imp.salva({ PROCESSORE_AUDIO: 'esagerato' }, { avanzate: false })).toThrow(/scelta/)
    expect(() => imp.salva({ NOME_RADIO: "l'altra" }, { avanzate: false })).toThrow(/apostrofi/)
    expect(() => imp.salva({ NOME_RADIO: 'a\nB=c' }, { avanzate: false })).toThrow()
    expect(() => imp.salva({ PIPPO: '1' }, { avanzate: false })).toThrow(/sconosciuta/)
    expect(() => imp.salva({ ESTERNA_PORTA: '8000' }, { avanzate: true })).toThrow(/diversa/)
    expect(() => imp.salva({ SRT_PORT: '443' }, { avanzate: true })).toThrow(/443/)
    expect(() => imp.salva({ SRT_PORT: '40010' }, { avanzate: true })).toThrow(/microfono/)
    expect(() => imp.salva({}, { avanzate: true, svuota: ['ICECAST_PASSWORD_SORGENTE'] })).toThrow(/vuoto/)
    expect(env()).toBe(prima)
  })

  it('si accorge se il servizio sul server non toglie la richiesta', () => {
    let t = Date.now()
    const { imp } = make(ESEMPIO, () => t)
    imp.applica()
    expect(imp.stato().servizioAssente).toBe(false)
    t += 120_000
    expect(imp.stato().servizioAssente).toBe(true)
    imp.annullaRichiesta()
    expect(imp.stato().richiesta).toBeUndefined()
  })
})
