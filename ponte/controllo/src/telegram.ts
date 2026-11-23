/**
 * Bot Telegram per etichettare i brani sconosciuti delle dirette esterne (scelta del 15/11/2026: stesso
 * bot e stessa chat degli allarmi; chiunque sia nella chat può etichettare).
 *
 * Per ogni brano sconosciuto il bot manda nella chat i 20 secondi di audio. Si risponde al messaggio con
 * "Artista - Titolo" (su una seconda riga, se si sanno, gli autori per la SIAE separati da virgola), oppure
 * si preme "Non è musica". Il comando /sconosciuti rimanda quelli ancora da etichettare.
 *
 * Con /menu (o /start) il bot mostra un menu a pulsanti: le sezioni fisse sui brani da etichettare e già
 * etichettati, più quelle passate dal server (cosa c'è in onda, ascoltatori, puntate, eventi e rotazione
 * della regia...). Le sezioni possono avere pulsanti propri (per esempio accendere o spegnere un evento).
 *
 * I messaggi si leggono con getUpdates (nessuna porta da aprire). Si accettano solo dalla chat configurata.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Unknown, UnknownLabel } from './riconoscimento.ts'
import { setAsideBroken } from './statoFile.ts'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface TelegramDeps {
  token: string
  chatId: string
  /** File dove si ricorda quale messaggio corrisponde a quale brano. */
  stateFile: string
  stationName: string
  get: (id: string) => Unknown | undefined
  pending: () => Unknown[]
  clipFile: (id: string) => string | null
  /** Brani già etichettati (per la sezione "Già etichettati"). */
  labelled?: () => Unknown[]
  /** Sezioni in più del menu. */
  sections?: Section[]
  label: (id: string, label: UnknownLabel, by: string) => void
  discard: (id: string, by: string) => void
  /** Altre funzioni del bot con pulsanti e risposte proprie (es. revisione delle puntate). */
  extensions?: BotExtension[]
  fetch?: Fetch
  log?: (s: string) => void
}

/** Testo di una sezione con, se servono, i suoi pulsanti (data: al massimo 40 caratteri). */
export interface SectionView {
  text: string
  buttons?: { text: string; data: string }[][]
}

/** Una sezione del menu: un pulsante che mostra un testo (con "Aggiorna" e "Menu" sotto). */
export interface Section {
  key: string
  label: string
  render: () => Promise<string | SectionView> | string | SectionView
  /**
   * Pulsante della sezione premuto (`data` è quello del pulsante). Può restituire un avviso breve e una vista
   * diversa da mostrare (per esempio una richiesta di conferma); senza vista la sezione si ridisegna.
   */
  act?: (data: string, by: string) => Promise<{ toast?: string; view?: SectionView } | void>
}

type Keyboard = { text: string; callback_data: string }[][]

/** Funzione in più del bot: risponde true se il pulsante o la risposta erano suoi. */
export interface BotExtension {
  callback?: (data: string, ctx: { by: string; messageId?: number; answer: (text?: string, alert?: boolean) => Promise<unknown> }) => Promise<boolean>
  reply?: (replyTo: number, text: string, ctx: { by: string; messageId: number; reply: (text: string) => Promise<unknown> }) => Promise<boolean>
}

/** "Artista - Titolo" (anche con – o —) e, sulla riga sotto, gli autori. */
export function parseLabel(text: string): UnknownLabel | null {
  const [first, ...rest] = text.trim().split(/\r?\n/)
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(first?.trim() ?? '')
  if (!m) return null
  const composer = rest
    .join(' ')
    .replace(/^\s*(autori|autore|compositori)\s*:\s*/i, '')
    .trim()
  return { artist: m[1].trim(), title: m[2].trim(), composer, publisher: '' }
}

interface State {
  offset: number
  /** message_id → id del brano sconosciuto */
  messages: Record<string, string>
}

interface Update {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number }
    from?: { first_name?: string; username?: string }
    text?: string
    reply_to_message?: { message_id: number }
  }
  callback_query?: {
    id: string
    from?: { first_name?: string; username?: string }
    data?: string
    message?: { message_id: number; chat: { id: number } }
  }
}

const who = (f?: { first_name?: string; username?: string }): string => `Telegram: ${f?.username ? `@${f.username}` : f?.first_name || 'qualcuno'}`
const when = (iso: string): string => new Date(iso).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export class LabelBot {
  private readonly d: TelegramDeps
  private readonly fetch: Fetch
  private readonly log: (s: string) => void
  private state: State = { offset: 0, messages: {} }
  private running = false
  private abort: AbortController | null = null

  constructor(d: TelegramDeps) {
    this.d = d
    this.fetch = d.fetch ?? fetch
    this.log = d.log ?? ((s) => console.log(`[telegram] ${s}`))
    if (existsSync(d.stateFile)) {
      try {
        this.state = { offset: 0, messages: {}, ...(JSON.parse(readFileSync(d.stateFile, 'utf8')) as Partial<State>) }
      } catch (e) {
        // file rovinato: si riparte (il file si copia da parte)
        setAsideBroken(d.stateFile, e, this.log)
      }
    }
  }

  private save(): void {
    writeFileSync(`${this.d.stateFile}.tmp`, JSON.stringify(this.state))
    renameSync(`${this.d.stateFile}.tmp`, this.d.stateFile)
  }

  /** Chiamata diretta alle API di Telegram (per le estensioni); la chat è sempre quella configurata. */
  api(method: string, body: Record<string, unknown> | FormData, timeoutMs = 15_000): Promise<any> {
    if (body instanceof FormData) body.set('chat_id', this.d.chatId)
    else body = { ...body, chat_id: this.d.chatId }
    return this.call(method, body, timeoutMs)
  }

  private async call(method: string, body: unknown, timeoutMs = 15_000, signal?: AbortSignal): Promise<any> {
    const isForm = body instanceof FormData
    let r: Response
    try {
      r = await this.fetch(`https://api.telegram.org/bot${this.d.token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      // gli errori di rete possono contenere l'indirizzo, cioè il token: nel log non deve finire
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(this.d.token ? msg.split(this.d.token).join('***') : msg)
    }
    const j = (await r.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null
    if (!r.ok || !j?.ok) throw new Error(j?.description ?? `HTTP ${r.status}`)
    return j.result
  }

  private reply(text: string, to?: number): Promise<unknown> {
    return this.call('sendMessage', { chat_id: this.d.chatId, text, ...(to ? { reply_parameters: { message_id: to } } : {}) }).catch((e: unknown) =>
      this.log(`messaggio non inviato: ${e instanceof Error ? e.message : String(e)}`)
    )
  }

  /** Pulsanti del menu, due per riga. */
  private menuKeyboard(): Keyboard {
    const n = this.d.pending().length
    const items = [
      { text: `🎵 Da etichettare${n ? ` (${n})` : ''}`, callback_data: 'sez:etichettare' },
      ...(this.d.labelled ? [{ text: '✅ Già etichettati', callback_data: 'sez:etichettati' }] : []),
      ...(this.d.sections ?? []).map((x) => ({ text: x.label, callback_data: `sez:${x.key}` }))
    ]
    const rows: Keyboard = []
    for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2))
    return rows
  }

  private menuText(): string {
    return `📻 ${this.d.stationName}: scegli una sezione.`
  }

  /** Testo di una sezione (null se non esiste). */
  private async sectionText(key: string): Promise<SectionView | null> {
    if (key === 'etichettati' && this.d.labelled) {
      const list = this.d.labelled().slice(-15).reverse()
      if (!list.length) return { text: '✅ Nessun brano etichettato finora.' }
      return { text: `✅ Ultimi brani etichettati:\n${list.map((u) => `• ${u.label!.artist} - ${u.label!.title}${u.label!.composer ? ` (autori: ${u.label!.composer})` : ''}`).join('\n')}` }
    }
    const sec = this.d.sections?.find((x) => x.key === key)
    if (!sec) return null
    try {
      const v = await sec.render()
      return typeof v === 'string' ? { text: v } : v
    } catch (e) {
      return { text: `${sec.label}: non disponibile (${e instanceof Error ? e.message : String(e)})` }
    }
  }

  /** Pulsanti della sezione (prefisso az:sezione:) più "Aggiorna" e "Menu". */
  private sectionKeyboard(key: string, view?: SectionView): Keyboard {
    const own: Keyboard = (view?.buttons ?? []).map((row) => row.map((b) => ({ text: b.text, callback_data: `az:${key}:${b.data}`.slice(0, 64) })))
    return [...own, [{ text: '🔄 Aggiorna', callback_data: `sez:${key}` }, { text: '⬅ Menu', callback_data: 'menu' }]]
  }

  /** Pulsante di una sezione premuto. */
  private async sectionAction(cb: NonNullable<Update['callback_query']>, answer: (text?: string, alert?: boolean) => Promise<unknown>): Promise<void> {
    const rest = cb.data!.slice(3)
    const sep = rest.indexOf(':')
    const key = sep < 0 ? rest : rest.slice(0, sep)
    const data = sep < 0 ? '' : rest.slice(sep + 1)
    const sec = this.d.sections?.find((x) => x.key === key)
    if (!sec?.act) return void (await answer('Pulsante non più valido', true))
    let res: { toast?: string; view?: SectionView } | void
    try {
      res = await sec.act(data, who(cb.from))
    } catch (e) {
      return void (await answer(`Non fatto: ${e instanceof Error ? e.message : String(e)}`, true))
    }
    await answer(res?.toast)
    if (!cb.message) return
    const view = res?.view ?? (await this.sectionText(key))
    if (view) await this.edit(cb.message.message_id, view.text, this.sectionKeyboard(key, view))
  }

  /** Manda il menu come nuovo messaggio. */
  async sendMenu(): Promise<void> {
    await this.call('sendMessage', { chat_id: this.d.chatId, text: this.menuText(), reply_markup: { inline_keyboard: this.menuKeyboard() } })
  }

  /** Manda una sezione come nuovo messaggio. */
  async sendSection(key: string): Promise<void> {
    const view = await this.sectionText(key)
    if (!view) return
    await this.call('sendMessage', { chat_id: this.d.chatId, text: view.text, reply_markup: { inline_keyboard: this.sectionKeyboard(key, view) } }).catch((e: unknown) =>
      this.log(`sezione non inviata: ${e instanceof Error ? e.message : String(e)}`)
    )
  }

  /** Manda i brani da etichettare (al massimo 20). */
  private async sendPending(to?: number): Promise<void> {
    const list = this.d.pending()
    if (!list.length) return void (await this.reply('Nessun brano da etichettare 👍', to))
    await this.reply(`Ti mando ${list.length} ${list.length === 1 ? 'brano' : 'brani'} da etichettare${list.length > 20 ? ' (i primi 20)' : ''}.`, to)
    for (const u of list.slice(0, 20)) await this.sendUnknown(u).catch((e: unknown) => this.log(`invio non riuscito: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** Sostituisce il testo di un messaggio del bot ("message is not modified" non è un errore). */
  private async edit(messageId: number, text: string, keyboard: Keyboard): Promise<void> {
    await this.call('editMessageText', { chat_id: this.d.chatId, message_id: messageId, text, reply_markup: { inline_keyboard: keyboard } }).catch((e: unknown) => {
      if (!(e instanceof Error && /not modified/i.test(e.message))) this.log(`messaggio non aggiornato: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  /** Toglie i pulsanti da un messaggio del bot ("message is not modified" non è un errore). */
  private async removeButton(messageId: number): Promise<void> {
    await this.call('editMessageReplyMarkup', { chat_id: this.d.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch((e: unknown) => {
      if (!(e instanceof Error && /not modified/i.test(e.message))) this.log(`pulsante non tolto: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  /** Manda nella chat l'audio di un brano sconosciuto. */
  async sendUnknown(u: Unknown): Promise<void> {
    const file = this.d.clipFile(u.id)
    const times = u.heard.length > 1 ? `, sentito ${u.heard.length} volte` : ''
    const caption =
      `🎵 ${this.d.stationName}: brano sconosciuto della diretta esterna (${when(u.heard[0])}, ${Math.round(u.seconds / 60)} min${times}).\n` +
      'Rispondi a questo messaggio con: Artista - Titolo\n(sulla riga sotto, se li sai, gli autori separati da virgola)'
    const keyboard = { inline_keyboard: [[{ text: '🚫 Non è musica', callback_data: `scarta:${u.id}` }]] }
    let msg: { message_id: number }
    if (file && existsSync(file)) {
      const form = new FormData()
      form.set('chat_id', this.d.chatId)
      form.set('caption', caption)
      form.set('title', 'Brano sconosciuto')
      form.set('reply_markup', JSON.stringify(keyboard))
      form.set('audio', new Blob([await readFile(file)], { type: 'audio/mpeg' }), `${u.id.replace('/', '-')}.mp3`)
      msg = await this.call('sendAudio', form, 60_000)
    } else {
      msg = await this.call('sendMessage', { chat_id: this.d.chatId, text: `${caption}\n(audio non disponibile)`, reply_markup: keyboard })
    }
    // il messaggio resta legato a quel brano preciso (numero + primo ascolto), non solo al numero
    this.state.messages[String(msg.message_id)] = `${u.id}@${u.heard[0] ?? ''}`
    this.save()
  }

  /** Il brano a cui si riferisce un messaggio del bot, se esiste ancora ed è proprio quello. */
  private target(messageId: number | undefined): string | undefined {
    const mapped = messageId === undefined ? undefined : this.state.messages[String(messageId)]
    if (!mapped) return undefined
    const at = mapped.lastIndexOf('@')
    const id = at < 0 ? mapped : mapped.slice(0, at)
    const u = this.d.get(id)
    if (!u || (at >= 0 && (u.heard[0] ?? '') !== mapped.slice(at + 1))) return undefined
    return id
  }

  /** Gestisce un aggiornamento di Telegram. */
  async handle(up: Update): Promise<void> {
    const cb = up.callback_query
    if (cb) {
      if (String(cb.message?.chat.id) !== String(this.d.chatId)) return
      const answer = (text?: string, alert = false): Promise<unknown> =>
        this.call('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text: text.slice(0, 200), show_alert: alert } : {}) }).catch(() => {})
      if (cb.data === 'menu') {
        await answer()
        if (cb.message) await this.edit(cb.message.message_id, this.menuText(), this.menuKeyboard())
        return
      }
      if (cb.data?.startsWith('sez:')) {
        const key = cb.data.slice(4)
        if (key === 'etichettare') {
          await answer()
          return void (await this.sendPending())
        }
        const view = await this.sectionText(key)
        await answer(view === null ? 'Sezione non più disponibile' : undefined)
        if (view !== null && cb.message) await this.edit(cb.message.message_id, view.text, this.sectionKeyboard(key, view))
        return
      }
      for (const x of this.d.extensions ?? []) {
        const ctx = { by: who(cb.from), messageId: cb.message?.message_id, answer: (text?: string, alert = false) => this.call('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {}) }
        if (cb.data && (await x.callback?.(cb.data, ctx))) return
      }
      if (cb.data?.startsWith('az:')) return void (await this.sectionAction(cb, answer))
      let id = cb.data?.startsWith('scarta:') ? cb.data.slice(7) : ''
      // il pulsante vale solo per il brano del suo messaggio (un numero potrebbe essere stato riusato)
      if (id && cb.message && this.state.messages[String(cb.message.message_id)] !== undefined && this.target(cb.message.message_id) !== id) id = ''
      let text = 'Già tolto'
      const u = id ? this.d.get(id) : undefined
      if (u?.label) {
        // già etichettato (qui o dal pannello): non si scarta più, e il pulsante si toglie
        await this.call('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: `Già etichettato come "${u.label.artist} - ${u.label.title}": non si può più segnare come "non è musica".`,
          show_alert: true
        }).catch(() => {})
        if (cb.message) await this.removeButton(cb.message.message_id)
        return
      }
      if (u) {
        this.d.discard(id, who(cb.from))
        text = 'Tolto dall\'archivio'
        if (cb.message) {
          await this.call('editMessageCaption', { chat_id: this.d.chatId, message_id: cb.message.message_id, caption: `🚫 Non era musica (${who(cb.from).slice(10)})` }).catch(() => {})
        }
      }
      await this.call('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {})
      return
    }
    const m = up.message
    if (!m || String(m.chat.id) !== String(this.d.chatId) || !m.text) return
    if (/^\/(start|menu)(@\w+)?\b/.test(m.text)) return void (await this.sendMenu().catch((e: unknown) => this.log(`menu non inviato: ${e instanceof Error ? e.message : String(e)}`)))
    if (/^\/sconosciuti(@\w+)?\b/.test(m.text)) return void (await this.sendPending(m.message_id))
    if (m.reply_to_message) {
      for (const x of this.d.extensions ?? []) {
        const ctx = { by: who(m.from), messageId: m.message_id, reply: (text: string) => this.reply(text, m.message_id) }
        if (await x.reply?.(m.reply_to_message.message_id, m.text, ctx)) return
      }
    }
    // /eventi, /rotazione...: apre direttamente la sezione con quel nome
    const direct = /^\/(\w+?)(@\w+)?(\s|$)/.exec(m.text)?.[1]
    if (direct && this.d.sections?.some((x) => x.key === direct && x.act)) return void (await this.sendSection(direct))
    if (!m.reply_to_message || this.state.messages[String(m.reply_to_message.message_id)] === undefined) return
    const target = this.target(m.reply_to_message.message_id)
    if (!target) return void (await this.reply('Questo brano non è più in archivio.', m.message_id))
    const label = parseLabel(m.text)
    if (!label) return void (await this.reply('Non ho capito: scrivi "Artista - Titolo" (con il trattino in mezzo).', m.message_id))
    try {
      this.d.label(target, label, who(m.from))
      // il pulsante "Non è musica" non serve più
      await this.removeButton(m.reply_to_message!.message_id)
      await this.reply(`✅ Salvato: ${label.artist} - ${label.title}${label.composer ? ` (autori: ${label.composer})` : ''}. Da ora viene riconosciuto.`, m.message_id)
    } catch (e) {
      await this.reply(`Non salvato: ${e instanceof Error ? e.message : String(e)}`, m.message_id)
    }
  }

  /** Lettura continua dei messaggi (long polling). */
  start(): void {
    if (this.running) return
    this.running = true
    // comandi suggeriti da Telegram quando si scrive "/"
    void this.call('setMyCommands', {
      commands: [
        { command: 'menu', description: 'Apri il menu della radio' },
        { command: 'sconosciuti', description: 'Brani da etichettare' },
        ...(this.d.sections ?? []).filter((x) => x.act).map((x) => ({ command: x.key, description: x.label.replace(/^\P{L}+/u, '') }))
      ]
    }).catch((e: unknown) => this.log(`comandi non impostati: ${e instanceof Error ? e.message : String(e)}`))
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.abort?.abort()
  }

  private async loop(): Promise<void> {
    let wait = 1000
    while (this.running) {
      try {
        this.abort = new AbortController()
        const ups = (await this.call(
          'getUpdates',
          { offset: this.state.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] },
          65_000,
          this.abort.signal
        )) as Update[]
        wait = 1000
        for (const up of ups) {
          this.state.offset = up.update_id + 1
          await this.handle(up).catch((e: unknown) => this.log(`errore: ${e instanceof Error ? e.message : String(e)}`))
        }
        if (ups.length) this.save()
      } catch (e) {
        if (!this.running) break
        // 409 = un altro programma legge lo stesso bot (o c'è un webhook): si riprova con calma
        this.log(`lettura messaggi: ${e instanceof Error ? e.message : String(e)}`)
        await new Promise((r) => setTimeout(r, wait))
        wait = Math.min(wait * 2, 60_000)
      }
    }
  }
}
