import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { guessFromName, Library } from './libreria.ts'
import { annotate, AutonomousPlayer } from './autonoma.ts'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lib-'))
  mkdirSync(join(dir, 'regia', 'Rock'), { recursive: true })
  const mk = (file: string, artist: string, title: string, secs: number) =>
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=d=${secs}`, '-metadata', `artist=${artist}`, '-metadata', `title=${title}`, '-b:a', '128k', join(dir, file)])
  mk('regia/Rock/a.mp3', 'Vasco', 'Albachiara', 70)
  mk('regia/Rock/b.mp3', 'Vasco', 'Sally', 70)
  mk('regia/c.mp3', 'Mina', 'Se telefonando', 70)
  writeFileSync(join(dir, 'Nomade - Io vagabondo.mp3'), 'non è un mp3')
})

describe('libreria del server', () => {
  it('legge i tag, cerca, usa il nome del file se i tag mancano', async () => {
    const lib = new Library(dir, join(dir, '.indice.json'))
    expect(await lib.scan()).toBe(4)
    const a = lib.get('regia/Rock/a.mp3')!
    expect(a).toMatchObject({ artist: 'Vasco', title: 'Albachiara', bitrate: 128 })
    expect(a.duration).toBeGreaterThan(69)
    expect(lib.get('Nomade - Io vagabondo.mp3')).toMatchObject({ artist: 'Nomade', title: 'Io vagabondo' })
    expect(lib.search('vasco ALBA').map((t) => t.id)).toEqual(['regia/Rock/a.mp3'])
    // una richiesta enorme viene tagliata e non blocca il servizio
    const t0 = Date.now()
    expect(lib.search('a '.repeat(400_000) + 'zzqx')).toEqual(lib.search('a'))
    expect(Date.now() - t0).toBeLessThan(2000)
    // i dati della regia vincono sui tag e restano dopo una nuova scansione
    lib.setMeta('regia/c.mp3', { title: 'Se telefonando (2023 Remaster)', gainDb: -3.5 })
    lib.save()
    const lib2 = new Library(dir, join(dir, '.indice.json'))
    await lib2.scan()
    expect(lib2.get('regia/c.mp3')).toMatchObject({ title: 'Se telefonando (2023 Remaster)', gainDb: -3.5 })
  })

  it('a caso evitando brani e artisti recenti', () => {
    const lib = new Library(dir, join(dir, '.indice.json'))
    const pick = lib.pickRandom(['regia/c.mp3'], ['vasco'], () => 0)
    // solo il file "Nomade" (durata 0 = sconosciuta) è libero da entrambe le regole
    expect(pick?.id).toBe('Nomade - Io vagabondo.mp3')
    expect(lib.pickRandom(lib.all().map((t) => t.id), [], () => 0)).not.toBeNull()
  })

  it('un brano caricato durante la scansione resta nell\'indice', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lib-'))
    copyFileSync(join(dir, 'regia/c.mp3'), join(d, 'a.mp3'))
    const lib = new Library(d, join(d, '.indice.json'))
    const orig = lib.addFile.bind(lib)
    let once = false
    // mentre la scansione legge a.mp3 (cartella già letta) arriva un caricamento dal pannello
    lib.addFile = async (file, meta) => {
      if (!once) {
        once = true
        copyFileSync(join(dir, 'regia/c.mp3'), join(d, 'b.mp3'))
        await orig(join(d, 'b.mp3'), { title: 'Caricato' })
      }
      return orig(file, meta)
    }
    await lib.scan()
    expect(lib.get('b.mp3')?.title).toBe('Caricato')
    expect(lib.get('a.mp3')).toBeTruthy()
  })

  it('un file sparito durante la scansione non interrompe la scansione', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lib-'))
    copyFileSync(join(dir, 'regia/c.mp3'), join(d, 'a.mp3'))
    copyFileSync(join(dir, 'regia/c.mp3'), join(d, 'b.mp3'))
    const lib = new Library(d, join(d, '.indice.json'))
    const orig = lib.addFile.bind(lib)
    lib.addFile = async (file, meta) => {
      if (file.endsWith('a.mp3')) rmSync(file)
      return orig(file, meta)
    }
    expect(await lib.scan()).toBe(1)
    expect(lib.get('b.mp3')).toBeTruthy()
    expect(lib.get('a.mp3')).toBeUndefined()
  })

  it('nome del file', () => {
    expect(guessFromName('/x/Lucio Dalla - 4 marzo 1943.mp3')).toEqual({ artist: 'Lucio Dalla', title: '4 marzo 1943' })
    expect(guessFromName('solo_titolo.mp3')).toEqual({ artist: '', title: 'solo titolo' })
  })
})

describe('diretta autonoma', () => {
  afterEach(() => vi.useRealTimers())

  function setup() {
    const lib = new Library(dir, join(dir, '.indice.json'))
    const calls: string[] = []
    let ok = true
    const p = new AutonomousPlayer(lib, {
      setActive: async (on) => (calls.push(`attiva ${on}`), ok),
      push: async (uri) => (calls.push(`push ${uri}`), ok),
      skip: async () => (calls.push('salta'), ok)
    })
    return { lib, p, calls, fail: () => (ok = false) }
  }

  it('avvia con il primo della coda, prepara il successivo prima della fine, ferma', async () => {
    vi.useFakeTimers()
    const { lib, p, calls } = setup()
    const active: string[] = []
    p.onActive = (on, by) => active.push(`${on} ${by}`)
    await p.run({ type: 'enqueue', id: 'regia/Rock/a.mp3', where: 'end' })
    await p.run({ type: 'enqueue', id: 'regia/c.mp3', where: 'end' })
    await p.run({ type: 'start' }, 'cristian')
    expect(calls).toEqual([`push annotate:title="Albachiara",artist="Vasco":${dir}/regia/Rock/a.mp3`, 'attiva true'])
    expect(p.state()).toMatchObject({ active: true, prepared: { id: 'regia/Rock/a.mp3' } })
    p.onTrackStart(lib.path(lib.get('regia/Rock/a.mp3')!))
    expect(p.state().onAir?.id).toBe('regia/Rock/a.mp3')
    expect(p.state().prepared).toBeNull()
    // il successivo si decide 20 secondi prima della fine: la coda resta modificabile
    await p.run({ type: 'enqueue', id: 'regia/Rock/b.mp3', where: 'next' })
    await vi.advanceTimersByTimeAsync(45_000)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls[2]).toBe(`push annotate:title="Sally",artist="Vasco":${dir}/regia/Rock/b.mp3`)
    expect(p.state().queue.map((t) => t.id)).toEqual(['regia/c.mp3'])
    await p.run({ type: 'stop' }, 'cristian')
    expect(calls.at(-1)).toBe('attiva false')
    // il brano preparato non si perde
    expect(p.state().queue.map((t) => t.id)).toEqual(['regia/Rock/b.mp3', 'regia/c.mp3'])
    expect(active).toEqual(['true cristian', 'false cristian'])
  })

  it('volume corretto, errori del mixer, coda vuota = brano a caso', async () => {
    expect(annotate('/musica/x.mp3', -3.25)).toBe('annotate:liq_amplify="-3.3 dB":/musica/x.mp3')
    expect(annotate('/musica/x.mp3', 0)).toBe('/musica/x.mp3')
    // titolo e artista per Icecast (riserva e diretta autonoma), con virgolette e barre protette
    expect(annotate('/musica/x.mp3', -3, { title: 'Ciao, "mondo"', artist: 'A\\B\nC' })).toBe(
      'annotate:liq_amplify="-3.0 dB",title="Ciao, \\"mondo\\"",artist="A\\\\B C":/musica/x.mp3'
    )
    expect(annotate('/musica/x.mp3', 0, { title: 'T', artist: '' })).toBe('annotate:title="T":/musica/x.mp3')
    const t = setup()
    await t.p.run({ type: 'start' })
    expect(t.calls[0]).toMatch(/^push /)
    await expect(t.p.run({ type: 'enqueue', id: 'nessuno', where: 'end' })).rejects.toThrow(/non trovato/)
    const u = setup()
    u.fail()
    await expect(u.p.run({ type: 'start' })).rejects.toThrow(/non risponde/)
    expect(u.p.state().active).toBe(false)
  })

  it('un brano in coda tolto dalla libreria si salta (non resta preparato un file che non c\'è)', async () => {
    const { lib, p, calls } = setup()
    await p.run({ type: 'enqueue', id: 'regia/Rock/a.mp3', where: 'end' })
    await p.run({ type: 'enqueue', id: 'regia/c.mp3', where: 'end' })
    lib.remove('regia/Rock/a.mp3')
    await p.run({ type: 'start' })
    expect(calls[0]).toMatch(/^push .*\/regia\/c\.mp3$/)
    expect(p.state()).toMatchObject({ prepared: { id: 'regia/c.mp3' }, queue: [] })
  })

  it('doppio clic su avvia: un solo brano al mixer e un solo avviso', async () => {
    const { p, calls } = setup()
    const active: string[] = []
    p.onActive = (on) => active.push(String(on))
    await Promise.all([p.run({ type: 'start' }), p.run({ type: 'start' })])
    expect(calls.filter((c) => c.startsWith('push'))).toHaveLength(1)
    expect(active).toEqual(['true'])
  })

  it('"salta" mentre scatta il timer di fine brano: un solo brano preparato', async () => {
    const { lib, p, calls } = setup()
    await p.run({ type: 'start' })
    p.onTrackStart(lib.path(p.state().prepared as never as Parameters<typeof lib.path>[0]))
    calls.length = 0
    await Promise.all([p.run({ type: 'skip' }), p.run({ type: 'skip' })])
    expect(calls.filter((c) => c.startsWith('push'))).toHaveLength(1)
  })

  it('riserva del ponte: brani a caso senza ripetere subito lo stesso artista', async () => {
    const lib = new Library(dir, join(dir, '.indice-riserva.json'))
    await lib.scan()
    const p = new AutonomousPlayer(lib, { setActive: async () => true, push: async () => true, skip: async () => true })
    const a = p.nextReserve()
    const b = p.nextReserve()
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    const artist = (u: string) => (u.includes('/c.mp3') ? 'Mina' : u.includes('Nomade') ? 'Nomade' : 'Vasco')
    // con più artisti in libreria, due brani di fila sono di artisti diversi
    expect(artist(a!)).not.toBe(artist(b!))
  })
})
