import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventSections, eventsView, profileCode, rotationView } from './eventiBot.ts'
import type { RemoteCommand, RemoteEventsInfo } from './protocol.ts'
import { LabelBot } from './telegram.ts'

const quiet = { name: 'Musica tranquilla', genres: ['jazz'], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null, energyMin: 1, energyMax: 4 }

function info(): RemoteEventsInfo {
  return {
    events: [
      { id: 1, label: 'Jingle orario', time: '*:00', days: [0, 1, 2, 3, 4, 5, 6], repeatMinutes: 0, untilTime: null, validFrom: null, validTo: null, mode: 'soft', toleranceSeconds: 0, actions: [{ type: 'random', kind: 'jingle', folder: '', genre: '' }], enabled: true },
      { id: 2, label: 'Sera', time: '22:00', days: [1, 2, 3, 4, 5], repeatMinutes: 0, untilTime: null, validFrom: null, validTo: null, mode: 'soft', toleranceSeconds: 0, actions: [{ type: 'rotation', profile: quiet }], enabled: false },
      { id: 3, label: 'Script', time: '03:00', days: [0], repeatMinutes: 0, untilTime: null, validFrom: null, validTo: null, mode: 'soft', toleranceSeconds: 0, actions: [{ type: 'command', command: '' }], enabled: true, locked: true }
    ],
    next: [{ id: 1, at: '2026-11-23T21:00:00.000Z' }],
    rotation: null,
    profiles: [quiet],
    rules: { artistSeparationMinutes: 60, titleSeparationMinutes: 180, jingleEvery: 4 },
    djMix: false,
    news: [],
    tracks: [],
    genres: [],
    at: '2026-11-23T20:30:00.000Z'
  }
}

describe('eventi e rotazione nel bot Telegram', () => {
  it('elenco con pulsanti, niente pulsanti per gli eventi con un comando esterno', () => {
    const v = eventsView(info())
    expect(v.text).toContain('✅ Jingle orario: ogni ora al minuto 00, tutti i giorni')
    expect(v.text).toContain('⏸ Sera: alle 22:00, lun-ven')
    expect(v.text).toContain('🔒 Script')
    const data = v.buttons!.flat().map((b) => b.data)
    expect(data).toEqual(['t:1:0', 'r:1', 't:2:1', 'r:2'])
  })

  it('rotazione: profili degli eventi e ritorno alla normale', () => {
    const v = rotationView({ ...info(), rotation: quiet })
    expect(v.text).toContain('Attiva: Musica tranquilla · generi: jazz · energia 1-4')
    expect(v.buttons!.flat().map((b) => b.data)).toEqual([`p:${profileCode(quiet)}`, 'p:-'])
  })

  it('i pulsanti mandano i comandi alla regia; "esegui ora" chiede conferma', async () => {
    const sent: { cmd: RemoteCommand; by: string }[] = []
    const lastAction = () => [...sent].reverse().find((s) => s.cmd.type !== 'events')
    const run = async (cmd: RemoteCommand, by: string) => {
      sent.push({ cmd, by })
      return info()
    }
    const calls: { method: string; body: any }[] = []
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ method: url.split('/').at(-1)!, body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 })
    }
    const bot = new LabelBot({
      token: 'T',
      chatId: '-100',
      stateFile: join(mkdtempSync(join(tmpdir(), 'tg-')), 'stato.json'),
      stationName: 'Radio',
      get: () => undefined,
      pending: () => [],
      sections: eventSections(run),
      clipFile: () => null,
      label: () => {},
      discard: () => {},
      fetch,
      log: () => {}
    })
    const press = (data: string) => ({ update_id: 1, callback_query: { id: 'cb', from: { username: 'cri' }, data, message: { message_id: 50, chat: { id: -100 } } } })

    // /eventi apre direttamente la sezione
    await bot.handle({ update_id: 1, message: { message_id: 5, chat: { id: -100 }, text: '/eventi' } })
    expect(calls.at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data).toBe('az:eventi:t:1:0')

    await bot.handle(press('az:eventi:t:1:0'))
    expect(lastAction()).toEqual({ cmd: { type: 'eventEnable', id: 1, on: false }, by: 'Telegram: @cri' })
    expect(calls.find((c) => c.method === 'answerCallbackQuery' && c.body.text)?.body.text).toBe('Spento: Jingle orario')

    const before = sent.length
    await bot.handle(press('az:eventi:r:2'))
    expect(sent.slice(before).map((s) => s.cmd.type)).toEqual(['events'])
    expect(calls.at(-1)!.body.text).toContain('Eseguire subito')
    await bot.handle(press('az:eventi:R:2'))
    expect(lastAction()!.cmd).toEqual({ type: 'eventRun', id: 2 })

    await bot.handle(press(`az:rotazione:p:${profileCode(quiet)}`))
    expect(lastAction()!.cmd).toEqual({ type: 'rotationSet', profile: quiet })
    await bot.handle(press('az:rotazione:p:-'))
    expect(lastAction()!.cmd).toEqual({ type: 'rotationSet', profile: null })
  })

  it('regia scollegata: avviso, nessun blocco', async () => {
    const [ev] = eventSections(async () => {
      throw new Error('regia scollegata dal ponte')
    })
    await expect(ev.act!('t:1:0', 'x')).rejects.toThrow('scollegata')
  })
})
