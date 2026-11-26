import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RadioDb } from '../src/core/db'
import { executeRemote } from '../src/core/remote'
import { cleanEvent, executeEventCommand as execAny, RemoteAiJob, type RemoteAiInfo, type RemoteEventsDeps, type RemoteEventsInfo } from '../src/core/remoteEvents'

const executeEventCommand = (...a: Parameters<typeof execAny>) => execAny(...a) as Promise<RemoteEventsInfo>
import type { ScheduledEvent } from '../src/core/types'

function setup() {
  const db = new RadioDb(join(mkdtempSync(join(tmpdir(), 'ev-remoto-')), 'r.db'))
  const ran: ScheduledEvent[] = []
  const deps: RemoteEventsDeps = {
    listEvents: async () => db.listEvents(),
    saveEvent: async (e) => {
      db.saveEvent(e)
      return db.listEvents()
    },
    deleteEvent: async (id) => {
      db.deleteEvent(id)
      return db.listEvents()
    },
    getSettings: async () => db.getSettings(),
    saveSettings: async (p) => {
      db.saveSettings(p)
    },
    runEvent: async (e) => {
      ran.push(e)
    },
    getTracks: async (ids) => db.getTracks(ids),
    listGenres: async () => db.listGenres(),
    now: () => new Date(2026, 10, 23, 20, 30)
  }
  return { db, deps, ran }
}

const base = { days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null, validFrom: null, validTo: null, mode: 'soft' as const, toleranceSeconds: 0, enabled: true }

describe('eventi e rotazioni comandati da remoto', () => {
  it('crea, accende/spegne, esegue ed elimina un evento', async () => {
    const { deps, ran } = setup()
    let info = await executeEventCommand({ type: 'eventSave', event: { ...base, label: 'Jingle', time: '*:00', actions: [{ type: 'random', kind: 'jingle', folder: '', genre: '' }] } }, deps)
    expect(info.events).toHaveLength(1)
    const id = info.events[0].id
    expect(info.next[0]).toMatchObject({ id })
    info = await executeEventCommand({ type: 'eventEnable', id, on: false }, deps)
    expect(info.events[0].enabled).toBe(false)
    expect(info.next).toEqual([])
    await executeEventCommand({ type: 'eventRun', id }, deps)
    expect(ran.map((e) => e.label)).toEqual(['Jingle'])
    info = await executeEventCommand({ type: 'eventDelete', id }, deps)
    expect(info.events).toEqual([])
  })

  it('da remoto non si crea un comando esterno, e quelli esistenti si vedono soltanto', async () => {
    const { db, deps, ran } = setup()
    await expect(
      executeEventCommand({ type: 'eventSave', event: { ...base, label: 'x', time: '10:00', actions: [{ type: 'command', command: 'calc.exe' }] } }, deps)
    ).rejects.toThrow('solo dalla regia')
    db.saveEvent({ ...base, label: 'Script', time: '03:00', actions: [{ type: 'command', command: 'C:\\script.bat' }] })
    const info = await executeEventCommand({ type: 'events' }, deps)
    expect(info.events[0]).toMatchObject({ locked: true, actions: [{ type: 'command', command: '' }] })
    expect(JSON.stringify(info)).not.toContain('script.bat')
    const id = info.events[0].id
    for (const cmd of [
      { type: 'eventRun', id },
      { type: 'eventEnable', id, on: false },
      { type: 'eventDelete', id },
      { type: 'eventSave', event: { ...base, id, label: 'Script', time: '03:00', actions: [{ type: 'clear' }] } }
    ] as const) {
      await expect(executeEventCommand(cmd as never, deps)).rejects.toThrow('solo dalla regia')
    }
    expect(ran).toEqual([])
    expect(db.listEvents()[0].actions).toEqual([{ type: 'command', command: 'C:\\script.bat' }])
  })

  it('ripulisce i dati in arrivo e usa la validazione della regia', async () => {
    const { deps } = setup()
    const e = cleanEvent({ ...base, label: 'x', time: '*:15', repeatMinutes: 30, days: [1, 1, 9, 'a'], actions: [{ type: 'rotation', profile: { name: 'Sera', genres: ['jazz', 3], energyMin: 0, hack: true } }], extra: 1 })
    expect(e.repeatMinutes).toBe(0)
    expect(e.days).toEqual([1])
    expect(e.actions[0]).toEqual({
      type: 'rotation',
      profile: { name: 'Sera', genres: ['jazz'], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null, energyMin: 1, energyMax: null }
    })
    expect(e).not.toHaveProperty('extra')
    await expect(executeEventCommand({ type: 'eventSave', event: { ...base, label: 'x', time: '25:00', actions: [{ type: 'clear' }] } }, deps)).rejects.toThrow('Orario non valido')
    await expect(executeEventCommand({ type: 'eventSave', event: { ...base, label: 'x', time: '10:00', actions: [{ type: 'play', trackId: 999 }] } }, deps)).rejects.toThrow(
      'non è più nella libreria'
    )
  })

  it('cambia rotazione e regole; la lista propone i profili usati negli eventi', async () => {
    const { db, deps } = setup()
    const sera = { name: 'Sera', genres: ['jazz'], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null, energyMin: null, energyMax: null }
    db.saveEvent({ ...base, label: 'Sera', time: '22:00', actions: [{ type: 'rotation', profile: sera }] })
    db.saveEvent({ ...base, label: 'Sera bis', time: '23:00', actions: [{ type: 'rotation', profile: sera }] })
    let info = await executeEventCommand({ type: 'events' }, deps)
    expect(info.profiles).toEqual([sera])
    info = await executeEventCommand({ type: 'rotationSet', profile: sera }, deps)
    expect(info.rotation).toEqual(sera)
    expect(db.getSettings().rotationProfile).toEqual(sera)
    info = await executeEventCommand({ type: 'rotationSet', profile: null }, deps)
    expect(info.rotation).toBeNull()
    info = await executeEventCommand({ type: 'rotationRules', rules: { artistSeparationMinutes: 90, jingleEvery: 99 } }, deps)
    expect(info.rules).toEqual({ artistSeparationMinutes: 90, titleSeparationMinutes: 180, jingleEvery: 50 })
  })

  it('passa dal comando remoto della regia (e una regia senza gestione eventi lo dice)', async () => {
    const { deps } = setup()
    const engine = {} as never
    const plain = { getTrack: async () => null, search: async () => [], carts: () => [], replay: async () => null }
    await expect(executeRemote(engine, { type: 'events' }, plain)).rejects.toThrow('non disponibile')
    const info = (await executeRemote(engine, { type: 'events' }, { ...plain, events: deps })) as { events: unknown[] }
    expect(info.events).toEqual([])
  })
})

describe("rotazioni con l'AI da remoto", () => {
  const plan = { slots: [{ name: 'Sera', days: [1, 2, 3, 4, 5], start: '22:00', end: '23:00', genres: ['jazz'], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null }] }

  it('la generazione parte in background, poi il piano si applica e diventa eventi', async () => {
    const { db, deps } = setup()
    let finish: (v: unknown) => void = () => {}
    let busy = false
    deps.ai = {
      status: async () => ({ installed: true, modelName: 'Qwen', busy }),
      generate: (d) => {
        db.saveSettings({ aiDescription: d })
        busy = true
        return new Promise((r) => (finish = r as never)).finally(() => (busy = false)) as never
      },
      cancel: async () => {},
      preview: async (p) => ({ plan: p, warnings: [], counts: [42], music: 100, seconds: 0 }),
      apply: async (p, replace) => {
        if (replace) for (const e of db.listEvents()) if (e.label.startsWith('AI · ')) db.deleteEvent(e.id)
        for (const s of p.slots) db.saveEvent({ ...base, label: `AI · ${s.name}`, time: s.start, days: s.days, actions: [{ type: 'rotation', profile: null }] })
        return db.listEvents()
      }
    }
    const job = new RemoteAiJob()
    const run = (cmd: object) => execAny(cmd as never, deps, 'anna', job) as Promise<RemoteAiInfo>
    let st = await run({ type: 'aiGenerate', description: 'la sera jazz' })
    expect(st.job).toMatchObject({ state: 'in_corso', by: 'anna' })
    expect(st.description).toBe('la sera jazz')
    await expect(run({ type: 'aiGenerate', description: 'altro' })).rejects.toThrow('già')
    finish({ plan, warnings: [], counts: [40], music: 100, seconds: 7 })
    await new Promise((r) => setTimeout(r, 0))
    st = await run({ type: 'aiStatus' })
    expect(st.job).toMatchObject({ state: 'pronto', result: { counts: [40], seconds: 7 } })
    st = await run({ type: 'aiPreview', plan })
    expect(st.job.result).toMatchObject({ counts: [42], seconds: 7 })
    const info = (await execAny({ type: 'aiApply', plan, replace: true }, deps, 'anna', job)) as RemoteEventsInfo
    expect(info.events.map((e) => e.label)).toEqual(['AI · Sera'])
    expect((await run({ type: 'aiStatus' })).job.state).toBe('libero')
  })

  it('il file .md per Claude si esporta anche senza modello, e il piano importato va in anteprima', async () => {
    const { deps } = setup()
    let saved = ''
    deps.now = () => new Date(2026, 10, 26, 22, 0)
    deps.ai = {
      status: async () => ({ installed: false, modelName: 'Qwen', busy: false }),
      generate: async () => ({}) as never,
      cancel: async () => {},
      preview: async (p) => ({ plan: p, warnings: [], counts: [12], music: 100, seconds: 0 }),
      apply: async () => [],
      exportText: async (d) => {
        saved = d
        return `# Rotazioni\n\n${d}`
      }
    }
    const job = new RemoteAiJob()
    const out = (await execAny({ type: 'aiExport', description: 'la sera jazz' }, deps, 'anna', job)) as { name: string; text: string }
    expect(out).toEqual({ name: 'rotazioni-per-claude_2026-11-26.md', text: '# Rotazioni\n\nla sera jazz' })
    expect(saved).toBe('la sera jazz')
    const st = (await execAny({ type: 'aiPreview', plan }, deps, 'anna', job)) as RemoteAiInfo
    expect(st.job).toMatchObject({ state: 'pronto', result: { counts: [12], seconds: 0 } })
  })

  it('una regia vecchia senza esportazione chiede di aggiornarla', async () => {
    const { deps } = setup()
    deps.ai = { status: async () => ({ installed: true, modelName: 'Qwen', busy: false }), generate: async () => ({}) as never, cancel: async () => {}, preview: async () => ({}) as never, apply: async () => [] }
    await expect(execAny({ type: 'aiExport', description: 'x' }, deps, 'a', new RemoteAiJob())).rejects.toThrow('aggiorna la regia')
  })

  it('senza modello scaricato lo dice (si scarica dalla regia)', async () => {
    const { deps } = setup()
    deps.ai = { status: async () => ({ installed: false, modelName: 'Qwen', busy: false }), generate: async () => ({}) as never, cancel: async () => {}, preview: async () => ({}) as never, apply: async () => [] }
    await expect(execAny({ type: 'aiGenerate', description: 'x' }, deps, 'a', new RemoteAiJob())).rejects.toThrow('dalla regia')
  })
})
