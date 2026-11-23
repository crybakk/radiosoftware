import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fasciaStudio, RegistrazioneProgrammi, type FineRegia, type ProgrammaStudio } from '../src/core/registrazioneProgrammi'

// lunedì 23/11/2026, programma 21:00-22:00 dallo studio, margine 2 minuti
const at = (hm: string): number => new Date(`2026-11-23T${hm}:00`).getTime()
const PROG: ProgrammaStudio = { id: 'sera', title: 'Sera', studio: true, marginMinutes: 2, slots: [{ days: [1], start: '21:00', end: '22:00' }] }

describe('fasce dei programmi dallo studio', () => {
  it('si accende 10 minuti prima e resta fino a fine più margine', () => {
    expect(fasciaStudio([PROG], new Date(at('20:49')), 10)).toBeNull()
    expect(fasciaStudio([PROG], new Date(at('20:51')), 10)?.programId).toBe('sera')
    expect(fasciaStudio([PROG], new Date(at('22:01')), 10)?.end).toBe(at('22:00'))
    expect(fasciaStudio([PROG], new Date(at('22:02')), 10)).toBeNull()
    expect(fasciaStudio([{ ...PROG, studio: false }], new Date(at('21:30')), 10)).toBeNull()
  })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'regprog-'))
  let now = at('20:45')
  let active = false
  const file = join(dir, 'reg.mp3')
  const started: string[] = []
  const recorder = {
    start: (title: string) => {
      active = true
      started.push(title)
    },
    stop: async () => {
      if (!active) return null
      active = false
      writeFileSync(file, Buffer.alloc(50_000))
      return { file, startedAt: '', endedAt: '' }
    },
    status: () => ({ active, bytes: active ? 1000 : 0, problem: null })
  }
  const fini: FineRegia[] = []
  const uploads: { f: FineRegia; bytes: number }[] = []
  let usa: 'ponte' | 'regia' = 'ponte'
  let down = false
  const server = {
    fine: async (f: FineRegia) => {
      if (down) throw new Error('ponte non raggiungibile')
      fini.push(f)
      return { usa }
    },
    upload: async (f: FineRegia, body: ReadableStream<Uint8Array>) => {
      let bytes = 0
      for await (const c of body as unknown as AsyncIterable<Uint8Array>) bytes += c.length
      uploads.push({ f, bytes })
    }
  }
  const r = new RegistrazioneProgrammi({ recorder, server: () => server, programs: async () => [PROG], stateFile: join(dir, 's.json'), now: () => now, log: () => {} })
  return {
    r,
    started,
    fini,
    uploads,
    set: (hm: string) => (now = at(hm)),
    usa: (u: 'ponte' | 'regia') => (usa = u),
    down: (d: boolean) => (down = d),
    dir
  }
}

describe('registrazione dei programmi in regia', () => {
  it('parte da sola all\'orario, avvisa prima della fine e si ferma da sola: il ponte tiene la sua', async () => {
    const t = setup()
    await t.r.tick()
    expect(t.r.status().fase).toBe('riposo')
    t.set('20:55')
    await t.r.tick()
    expect(t.r.status().fase).toBe('pronta')
    t.set('21:00')
    await t.r.tick()
    expect(t.started).toEqual(['Sera'])
    expect(t.r.status().corrente?.startAuto).toBe(true)
    t.set('21:56')
    await t.r.tick()
    expect(t.r.status().fase).toBe('avviso-fine')
    expect(t.r.status().corrente?.stopAt).toBe(at('22:02'))
    t.set('22:02')
    await t.r.tick()
    await new Promise((ok) => setTimeout(ok, 10))
    expect(t.r.status().corrente).toBeNull()
    expect(t.fini).toEqual([{ programId: 'sera', startedAt: at('21:00'), endedAt: at('22:02'), startMark: null, endMark: null, startAuto: true, endAuto: true }])
    expect(t.uploads).toEqual([])
    expect(t.r.status().invii).toEqual([])
    // finita la fascia non riparte
    await t.r.tick()
    expect(t.started).toHaveLength(1)
  })

  it('"Registra adesso" prima dell\'orario, poi "Segna inizio" e "Fine programma"; con interruzioni il file parte', async () => {
    const t = setup()
    t.usa('regia')
    t.set('20:55')
    await t.r.tick()
    t.r.registra('sera')
    expect(t.r.status().corrente?.startAuto).toBe(false)
    t.set('21:01')
    t.r.registra()
    expect(t.r.status().corrente?.startMark).toBe(at('21:01'))
    t.set('21:30')
    await t.r.tick()
    expect(t.started).toHaveLength(1)
    t.set('21:58')
    await t.r.fine()
    await new Promise((ok) => setTimeout(ok, 30))
    expect(t.fini[0]).toMatchObject({ startedAt: at('20:55'), startMark: at('21:01'), endMark: at('21:58'), startAuto: false, endAuto: false })
    expect(t.uploads).toEqual([{ f: t.fini[0], bytes: 50_000 }])
  })

  it('"Non fermare" sospende lo stop automatico', async () => {
    const t = setup()
    t.set('21:00')
    await t.r.tick()
    t.set('21:57')
    await t.r.tick()
    t.r.nonFermare()
    expect(t.r.status().corrente?.stopAt).toBeNull()
    t.set('22:10')
    await t.r.tick()
    expect(t.r.status().corrente).not.toBeNull()
  })

  it('ponte non raggiungibile: la registrazione resta in attesa e si riprova', async () => {
    const t = setup()
    t.down(true)
    t.set('21:00')
    await t.r.tick()
    t.set('21:50')
    await t.r.fine()
    await new Promise((ok) => setTimeout(ok, 10))
    expect(t.r.status().invii[0].errore).toMatch(/non raggiungibile/)
    t.down(false)
    t.set('21:52')
    await t.r.tick()
    await new Promise((ok) => setTimeout(ok, 10))
    expect(t.fini).toHaveLength(1)
    expect(t.r.status().invii).toEqual([])
  })

  it('registrazione a mano fuori fascia: serve scegliere il programma', async () => {
    const t = setup()
    t.set('15:00')
    await t.r.tick()
    expect(() => t.r.registra()).toThrow(/scegli il programma/)
    t.r.registra('sera')
    expect(t.r.status().corrente?.stopAt).toBeNull()
  })
})
