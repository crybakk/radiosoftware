import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Unknown, UnknownLabel } from './riconoscimento.ts'
import { LabelBot, parseLabel } from './telegram.ts'

describe('etichetta scritta su Telegram', () => {
  it('legge "Artista - Titolo" e gli autori sulla riga sotto', () => {
    expect(parseLabel('Lucio Dalla - Caruso')).toEqual({ artist: 'Lucio Dalla', title: 'Caruso', composer: '', publisher: '' })
    expect(parseLabel('Mina – Se telefonando\nAutori: Costanzo, Morricone')).toEqual({
      artist: 'Mina',
      title: 'Se telefonando',
      composer: 'Costanzo, Morricone',
      publisher: ''
    })
    expect(parseLabel('AC-DC - Thunderstruck')?.artist).toBe('AC-DC')
    expect(parseLabel('solo un titolo')).toBeNull()
  })
})

type Call = { method: string; body: any }

function setup(chatId = '-100') {
  const dir = mkdtempSync(join(tmpdir(), 'tg-'))
  const items = new Map<string, Unknown>([
    ['sconosciuto/1', { id: 'sconosciuto/1', heard: ['2026-11-15T20:00:00Z'], seconds: 200, label: null }],
    ['sconosciuto/2', { id: 'sconosciuto/2', heard: ['2026-11-15T20:05:00Z'], seconds: 180, label: { artist: 'Già', title: 'Fatto', composer: '', publisher: '' } }]
  ])
  const clip = join(dir, 'clip.mp3')
  writeFileSync(clip, Buffer.from([0xff, 0xfb, 0, 0]))
  const calls: Call[] = []
  let msgId = 100
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = url.split('/').at(-1)!
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body ?? '{}'))
    calls.push({ method, body })
    const result = method === 'sendAudio' || method === 'sendMessage' ? { message_id: ++msgId } : true
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  }
  const labelled: { id: string; label: UnknownLabel; by: string }[] = []
  const discarded: string[] = []
  const bot = new LabelBot({
    token: 'T',
    chatId,
    stateFile: join(dir, 'stato.json'),
    stationName: 'Radio Test',
    get: (id) => items.get(id),
    pending: () => [...items.values()].filter((u) => !u.label),
    labelled: () => [...items.values()].filter((u) => u.label),
    sections: [{ key: 'ascoltatori', label: '🎧 Ascoltatori', render: () => '🎧 Adesso: 12' }],
    clipFile: () => clip,
    label: (id, label, by) => {
      labelled.push({ id, label, by })
      items.get(id)!.label = label
    },
    discard: (id) => {
      discarded.push(id)
      items.delete(id)
    },
    fetch,
    log: () => {}
  })
  return { bot, calls, labelled, discarded, dir }
}

const msg = (text: string, extra: object = {}, chat = -100) => ({
  update_id: 1,
  message: { message_id: 5, chat: { id: chat }, from: { username: 'cri' }, text, ...extra }
})
const press = (data: string, chat = -100) => ({
  update_id: 2,
  callback_query: { id: 'cb', from: { first_name: 'Anna' }, data, message: { message_id: 50, chat: { id: chat } } }
})

describe('bot Telegram', () => {
  it('manda l\'audio e salva l\'etichetta data in risposta', async () => {
    const { bot, calls, labelled } = setup()
    await bot.sendUnknown({ id: 'sconosciuto/1', heard: ['2026-11-15T20:00:00Z'], seconds: 200, label: null })
    const sent = calls.find((c) => c.method === 'sendAudio')!
    expect(sent.body.chat_id).toBe('-100')
    expect(JSON.parse(sent.body.reply_markup).inline_keyboard[0][0].callback_data).toBe('scarta:sconosciuto/1')
    await bot.handle(msg('Lucio Dalla - Caruso\nDalla', { reply_to_message: { message_id: 101 } }))
    expect(labelled).toEqual([{ id: 'sconosciuto/1', label: { artist: 'Lucio Dalla', title: 'Caruso', composer: 'Dalla', publisher: '' }, by: 'Telegram: @cri' }])
    expect(calls.at(-1)!.body.text).toMatch(/^✅ Salvato/)
    // il pulsante "Non è musica" si toglie dal messaggio dell'audio
    expect(calls.find((c) => c.method === 'editMessageReplyMarkup')!.body).toEqual({ chat_id: '-100', message_id: 101, reply_markup: { inline_keyboard: [] } })
  })

  it('"Non è musica" su un brano già etichettato: rifiutato con la spiegazione, il pulsante sparisce', async () => {
    const { bot, calls, discarded } = setup()
    await bot.handle(press('scarta:sconosciuto/2'))
    expect(discarded).toEqual([])
    const ans = calls.find((c) => c.method === 'answerCallbackQuery')!
    expect(ans.body.text).toContain('Già etichettato come "Già - Fatto"')
    expect(calls.find((c) => c.method === 'editMessageReplyMarkup')!.body.message_id).toBe(50)
  })

  it('file di stato rovinato: copiato da parte', () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'stato.json'), '{rotto')
    const logs: string[] = []
    new LabelBot({ token: 'T', chatId: '-1', stateFile: join(dir, 'stato.json'), stationName: 'R', get: () => undefined, pending: () => [], clipFile: () => null, label: () => {}, discard: () => {}, log: (s) => logs.push(s) })
    expect(readdirSync(dir).some((f) => f.startsWith('stato.json.rovinato-'))).toBe(true)
    expect(logs.join('\n')).toContain('non leggibile')
  })

  it('ricorda i messaggi anche dopo un riavvio', async () => {
    const a = setup()
    await a.bot.sendUnknown({ id: 'sconosciuto/1', heard: ['2026-11-15T20:00:00Z'], seconds: 200, label: null })
    const b = setup()
    // stesso file di stato: un bot nuovo riconosce la risposta
    const bot2 = new LabelBot({ ...(b.bot as any).d, stateFile: join(a.dir, 'stato.json') })
    await bot2.handle(msg('X - Y', { reply_to_message: { message_id: 101 } }))
    expect(b.labelled[0]?.id).toBe('sconosciuto/1')
  })

  it('"Non è musica" toglie il brano', async () => {
    const { bot, calls, discarded } = setup()
    await bot.handle(press('scarta:sconosciuto/1'))
    expect(discarded).toEqual(['sconosciuto/1'])
    expect(calls.find((c) => c.method === 'answerCallbackQuery')!.body.text).toBe("Tolto dall'archivio")
  })

  it('ignora le altre chat', async () => {
    const { bot, calls, discarded } = setup()
    await bot.handle(msg('/menu', {}, -999))
    await bot.handle(press('scarta:sconosciuto/1', -999))
    expect(calls).toEqual([])
    expect(discarded).toEqual([])
  })

  it('menu a pulsanti con le sezioni', async () => {
    const { bot, calls } = setup()
    await bot.handle(msg('/start'))
    const menu = calls.at(-1)!
    expect(menu.method).toBe('sendMessage')
    const buttons = menu.body.reply_markup.inline_keyboard.flat().map((b: { text: string }) => b.text)
    expect(buttons).toEqual(['🎵 Da etichettare (1)', '✅ Già etichettati', '🎧 Ascoltatori'])

    await bot.handle(press('sez:ascoltatori'))
    const edit = calls.at(-1)!
    expect(edit.method).toBe('editMessageText')
    expect(edit.body.text).toBe('🎧 Adesso: 12')
    expect(edit.body.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual(['sez:ascoltatori', 'menu'])

    await bot.handle(press('sez:etichettati'))
    expect(calls.at(-1)!.body.text).toContain('Già - Fatto')

    await bot.handle(press('sez:etichettare'))
    expect(calls.filter((c) => c.method === 'sendAudio')).toHaveLength(1)

    await bot.handle(press('menu'))
    expect(calls.at(-1)!.body.text).toContain('scegli una sezione')
  })

  it('una sezione che si rompe non blocca il bot', async () => {
    const { bot, calls } = setup()
    ;(bot as any).d.sections = [{ key: 'x', label: 'X', render: () => { throw new Error('giù') } }]
    await bot.handle(press('sez:x'))
    expect(calls.at(-1)!.body.text).toBe('X: non disponibile (giù)')
  })

  it('il token non finisce nel log quando la rete dà errore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-'))
    const logs: string[] = []
    const token = '123456:SEGRETO'
    const bot = new LabelBot({
      token,
      chatId: '-100',
      stateFile: join(dir, 'stato.json'),
      stationName: 'Radio Test',
      get: () => undefined,
      pending: () => [],
      clipFile: () => null,
      label: () => {},
      discard: () => {},
      fetch: async (url) => {
        throw new TypeError(`fetch failed: ${url}`)
      },
      log: (s) => logs.push(s)
    })
    await bot.handle(msg('/sconosciuti'))
    expect(logs.join('\n')).toContain('fetch failed')
    expect(logs.join('\n')).not.toContain('SEGRETO')
  })
})
