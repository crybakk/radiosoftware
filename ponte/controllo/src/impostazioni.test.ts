import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
    expect(() => imp.salva({ NOME_RADIO: "l'altra $X" }, { avanzate: false })).toThrow(/apostrofo/)
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

  it('resta "in corso" finché non arriva l\'esito nuovo, anche dopo che il servizio ha tolto la richiesta', () => {
    let t = Date.parse('2026-11-16T10:00:00Z')
    const { imp, dir } = make(ESEMPIO, () => t)
    // esito di un riavvio precedente, andato bene
    writeFileSync(join(dir, 'esito.json'), JSON.stringify({ quando: '2026-11-16T09:00:00.123456+00:00', ok: true, messaggio: 'Impostazioni applicate' }))
    imp.salva({ NOME_RADIO: 'Radio Nuova' }, { avanzate: false })
    imp.applica()
    expect(imp.stato().inCorso).toBe(true)
    // il servizio sul server toglie subito la richiesta e lancia docker compose (che ci mette un po')
    unlinkSync(join(dir, 'applica'))
    t += 5000
    expect(imp.stato()).toMatchObject({ inCorso: true, senzaRisposta: false })
    // docker compose fallisce: l'esito nuovo è quello che conta
    writeFileSync(join(dir, 'esito.json'), JSON.stringify({ quando: '2026-11-16T10:00:20.5+00:00', ok: false, messaggio: 'Errore: porta occupata' }))
    t += 20_000
    expect(imp.stato()).toMatchObject({ inCorso: false, senzaRisposta: false, esito: { ok: false } })
  })

  it('una richiesta arrivata mentre il server applicava la precedente resta in corso', () => {
    let t = Date.parse('2026-11-16T10:00:00Z')
    const { imp, dir } = make(ESEMPIO, () => t)
    imp.applica()
    unlinkSync(join(dir, 'applica'))
    t += 2000
    imp.applica()
    // finisce il primo riavvio, dopo la seconda richiesta
    writeFileSync(join(dir, 'esito.json'), JSON.stringify({ quando: '2026-11-16T10:00:05+00:00', ok: true, messaggio: 'Impostazioni applicate' }))
    t += 5000
    expect(imp.stato().inCorso).toBe(true)
  })

  it('dopo 10 minuti senza esito dice che il riavvio non ha risposto', () => {
    let t = Date.parse('2026-11-16T10:00:00Z')
    const { imp, dir } = make(ESEMPIO, () => t)
    imp.applica()
    unlinkSync(join(dir, 'applica'))
    t += 11 * 60_000
    expect(imp.stato()).toMatchObject({ inCorso: true, senzaRisposta: true, servizioAssente: false })
  })

  it('un valore vuoto nel file vale il predefinito (come in docker-compose.yml)', () => {
    const { imp, env } = make('MICROFONO_REMOTO=\nICECAST_BITRATE=\nNOME_RADIO=Prova\n')
    const v = imp.elenco()
    expect(v.find((x) => x.chiave === 'MICROFONO_REMOTO')!.valore).toBe('si')
    expect(v.find((x) => x.chiave === 'ICECAST_BITRATE')!.valore).toBe('128')
    // il pannello rimanda il valore che mostra: non è un cambio
    expect(imp.salva({ MICROFONO_REMOTO: 'si', ICECAST_BITRATE: '128' }, { avanzate: false }).cambiate).toEqual([])
    expect(imp.salva({ MICROFONO_REMOTO: 'no' }, { avanzate: false }).cambiate).toEqual(['MICROFONO_REMOTO'])
    expect(leggiEnv(env()).MICROFONO_REMOTO).toBe('no')
  })
})

describe('file .env scritto a mano o con caratteri strani', () => {
  it('valori tra virgolette seguiti da un commento', () => {
    expect(leggiEnv("NOME_RADIO='Radio Pop' # il nome\nB=\"a \\\"b\\\" c\"   # commento\n")).toEqual({ NOME_RADIO: 'Radio Pop', B: 'a "b" c' })
  })

  it('rifiuta un valore che finisce con \\ (Docker Compose non leggerebbe più il file)', () => {
    const { imp, env } = make()
    const prima = env()
    expect(() => imp.salva({ SMTP_PASSWORD: 'segreta\\' }, { avanzate: false })).toThrow(/finire/)
    expect(env()).toBe(prima)
    // in mezzo va bene
    imp.salva({ SMTP_PASSWORD: 'a\\b c', NOME_RADIO: 'Radio Città ★ #1 $HOME "x"' }, { avanzate: false })
    expect(leggiEnv(env())).toMatchObject({ SMTP_PASSWORD: 'a\\b c', NOME_RADIO: 'Radio Città ★ #1 $HOME "x"' })
  })
})

describe('mount', () => {
  it('accetta solo caratteri sicuri (il mount finisce anche nel Caddyfile)', async () => {
    const { controlla } = await import('./impostazioni.ts')
    const v = VOCI.find((x) => x.chiave === 'ICECAST_MOUNT')!
    expect(controlla(v, '/radio.mp3')).toBe('/radio.mp3')
    expect(() => controlla(v, '/radio{x}')).toThrow()
    expect(() => controlla(v, '/a"b')).toThrow()
  })
})

describe('apostrofi', () => {
  it("un nome con l'apostrofo si salva tra virgolette doppie e si rilegge uguale", () => {
    const v = VOCI.find((x) => x.chiave === 'NOME_RADIO')!
    expect(scriviValore("Radio dell'Isola")).toBe(`"Radio dell'Isola"`)
    const testo = aggiornaEnv('NOME_RADIO=x\n', { NOME_RADIO: "Radio dell'Isola" })
    expect(leggiEnv(testo).NOME_RADIO).toBe("Radio dell'Isola")
    expect(scriviValore('con spazio')).toBe("'con spazio'")
    expect(v.chiave).toBe('NOME_RADIO')
  })
})
