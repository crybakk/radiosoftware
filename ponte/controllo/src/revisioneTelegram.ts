/**
 * Revisione delle puntate da Telegram (richiesta di cristian, 23/11/2026), con il bot delle etichette.
 *
 * Per ogni puntata da rivedere il bot manda:
 *   - un messaggio con programma, data, durata, motivo, segni e taglio proposto, con i pulsanti
 *     "✅ Pubblica" e "🗑 Elimina" (l'eliminazione chiede conferma);
 *   - per ogni interruzione 20 secondi di audio intorno al punto;
 *   - la registrazione intera, in una copia leggera che stia nel limite di 50 MB di Telegram (divisa in
 *     parti se il programma è molto lungo).
 * Per cambiare il taglio si risponde al messaggio con "inizio 2:10 fine 1:01:30" (anche uno solo dei due).
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Episode, Programs } from './programmi.ts'
import type { BotExtension } from './telegram.ts'
import { setAsideBroken } from './statoFile.ts'

/** Limite di Telegram per i file mandati da un bot: 50 MB; si resta un po' sotto. */
export const LIMITE_BYTE = 45 * 1024 * 1024
const MAX_CLIP = 10

export function hms(s: number): string {
  const t = Math.max(0, Math.round(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** "1:02:03", "2:10", "75" → secondi (NaN se non valido). */
export function leggiTempo(t: string): number {
  const parts = t.trim().replace(/\./g, ':').split(':')
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return NaN
  return parts.map(Number).reduce((a, n) => a * 60 + n, 0)
}

/** "inizio 2:10 fine 1:01:30" → { from, to } (quelli scritti). */
export function leggiTaglio(text: string): { from?: number; to?: number } | null {
  const a = /inizio\s*[:=]?\s*([\d:.]+)/i.exec(text)
  const b = /fine\s*[:=]?\s*([\d:.]+)/i.exec(text)
  if (!a && !b) return null
  const from = a ? leggiTempo(a[1]) : undefined
  const to = b ? leggiTempo(b[1]) : undefined
  if ((a && !Number.isFinite(from)) || (b && !Number.isFinite(to))) return null
  return { ...(a ? { from } : {}), ...(b ? { to } : {}) }
}

/**
 * Qualità della copia intera per Telegram: la più alta (fino a 96 kbit/s mono) che sta nel limite; sotto
 * i 32 kbit/s la registrazione si divide in parti.
 */
export function pianoCopia(seconds: number, limite = LIMITE_BYTE): { kbps: number; parti: { from: number; length: number }[] } {
  const kbps = Math.max(32, Math.min(96, Math.floor((limite * 8) / Math.max(1, seconds) / 1000)))
  const perParte = Math.floor((limite * 8) / (kbps * 1000))
  const parti: { from: number; length: number }[] = []
  for (let from = 0; from < seconds; from += perParte) parti.push({ from, length: Math.min(perParte, seconds - from) })
  return { kbps, parti: parti.length ? parti : [{ from: 0, length: seconds }] }
}

export interface RevisioneDeps {
  bot: { api: (method: string, body: Record<string, unknown> | FormData, timeoutMs?: number) => Promise<any> }
  programs: Programs
  stateFile: string
  /** Cartella per le copie provvisorie dell'audio. */
  tmpDir: string
  publish: (id: string, meta: { from: number; to: number; title: string; description: string }) => Promise<Episode>
  ffmpeg?: string
  /** "nice" per tenere bassa la priorità; vuoto nei test. */
  nice?: string
  log?: (s: string) => void
}

interface State {
  /** message_id → id della puntata */
  messages: Record<string, string>
}

export class RevisioneTelegram implements BotExtension {
  private readonly d: RevisioneDeps
  private readonly log: (s: string) => void
  private state: State = { messages: {} }
  private coda: Promise<unknown> = Promise.resolve()

  constructor(d: RevisioneDeps) {
    this.d = d
    this.log = d.log ?? ((s) => console.log(`[telegram revisione] ${s}`))
    if (existsSync(d.stateFile)) {
      try {
        this.state = { messages: {}, ...(JSON.parse(readFileSync(d.stateFile, 'utf8')) as Partial<State>) }
      } catch (e) {
        setAsideBroken(d.stateFile, e, this.log)
      }
    }
  }

  private save(): void {
    // si tengono gli ultimi 500 messaggi
    const keys = Object.keys(this.state.messages)
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete this.state.messages[k]
    writeFileSync(`${this.d.stateFile}.tmp`, JSON.stringify(this.state))
    renameSync(`${this.d.stateFile}.tmp`, this.d.stateFile)
  }

  private titolo(e: Episode): string {
    return this.d.programs.get(e.programId)?.title ?? e.programId
  }

  testo(e: Episode): string {
    const when = new Date(e.recordedFrom).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    const lines = [`📝 Puntata da rivedere: ${this.titolo(e)}`, `${e.title}`, `🕒 ${when} · durata ${hms(e.length)}${e.source === 'regia' ? ' · registrata in regia' : ''}`]
    if (e.reason) lines.push(`⚠️ ${e.reason}`)
    if (e.markers?.length) {
      lines.push('', 'Segni:')
      for (const m of e.markers) {
        if (m.kind === 'interruzione') lines.push(`🔴 ${hms(m.at)} interruzione${m.length ? ` di ${m.length} s` : ''}${m.note ? ` (${m.note})` : ''}`)
        else lines.push(`📍 ${hms(m.at)} ${m.kind === 'inizio' ? 'inizio programma' : 'fine programma'}`)
      }
    }
    const cut = e.cut ?? { from: 0, to: e.length }
    lines.push('', `✂️ Si pubblica da ${hms(cut.from)} a ${hms(cut.to)}${e.stereotool ? ', poi passa in Stereo Tool' : ''}.`)
    lines.push('Per cambiare rispondi a questo messaggio con: inizio 0:02:10 fine 1:01:30')
    return lines.join('\n')
  }

  private tasti(id: string): { inline_keyboard: { text: string; callback_data: string }[][] } {
    return { inline_keyboard: [[{ text: '✅ Pubblica', callback_data: `rev:pub:${id}` }, { text: '🗑 Elimina', callback_data: `rev:del:${id}` }]] }
  }

  /** Manda la puntata da rivedere (in coda: una alla volta). */
  invia(e: Episode): Promise<void> {
    const job = this.coda.then(() => this.manda(e.id))
    this.coda = job.catch((err: unknown) => this.log(`invio non riuscito: ${err instanceof Error ? err.message : String(err)}`))
    return job
  }

  private async manda(id: string): Promise<void> {
    const e = this.d.programs.episode(id)
    if (!e || e.status !== 'bozza') return
    const msg = (await this.d.bot.api('sendMessage', { text: this.testo(e), reply_markup: this.tasti(id) })) as { message_id: number }
    this.state.messages[String(msg.message_id)] = id
    this.save()
    const raw = this.d.programs.rawFile(id)
    // 20 secondi intorno a ogni interruzione
    const interr = (e.markers ?? []).filter((m) => m.kind === 'interruzione').slice(0, MAX_CLIP)
    for (const m of interr) {
      const from = Math.max(0, m.at - 10)
      await this.mandaAudio(raw, from, 20 + Math.min(m.length ?? 0, 10), 96, `🔴 Interruzione alle ${hms(m.at)} (da ${hms(from)})`, `interruzione ${hms(m.at)}`, msg.message_id)
    }
    if (e.markers && interr.length < e.markers.filter((m) => m.kind === 'interruzione').length) {
      await this.d.bot.api('sendMessage', { text: `…e altre interruzioni: ascoltale dal pannello.`, reply_parameters: { message_id: msg.message_id } })
    }
    // registrazione intera, leggera
    const plan = pianoCopia(e.length || 1)
    for (const [i, p] of plan.parti.entries()) {
      const part = plan.parti.length > 1 ? ` (parte ${i + 1} di ${plan.parti.length}, da ${hms(p.from)})` : ''
      await this.mandaAudio(raw, p.from, p.length, plan.kbps, `🎧 Registrazione intera${part}`, `${this.titolo(e)}${part}`, msg.message_id)
    }
  }

  private async mandaAudio(raw: string, from: number, length: number, kbps: number, caption: string, title: string, replyTo: number): Promise<void> {
    const out = join(this.d.tmpDir, `revisione-${process.pid}-${Date.now()}.mp3`)
    try {
      await this.taglia(raw, out, from, length, kbps)
      const form = new FormData()
      form.set('caption', caption)
      form.set('title', title)
      form.set('reply_parameters', JSON.stringify({ message_id: replyTo }))
      form.set('audio', new Blob([await readFile(out)], { type: 'audio/mpeg' }), `${title.replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 60) || 'puntata'}.mp3`)
      await this.d.bot.api('sendAudio', form, 15 * 60_000)
    } finally {
      rmSync(out, { force: true })
    }
  }

  private taglia(raw: string, out: string, from: number, length: number, kbps: number): Promise<void> {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', from.toFixed(2), '-t', length.toFixed(2), '-i', raw, '-vn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-map_metadata', '-1', out]
    const ffmpeg = this.d.ffmpeg ?? 'ffmpeg'
    const nice = this.d.nice ?? 'nice'
    const [cmd, all] = nice ? [nice, ['-n', '19', ffmpeg, ...args]] : [ffmpeg, args]
    return new Promise((ok, fail) => {
      const c = spawn(cmd, all, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      c.stderr.on('data', (x: Buffer) => (err = (err + String(x)).slice(-300)))
      c.on('error', (e) => fail(e))
      c.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`copia per Telegram non riuscita: ${err.trim().split('\n').pop() ?? code}`))))
    })
  }

  private async aggiorna(messageId: number | undefined, text: string, tasti: boolean, id: string): Promise<void> {
    if (messageId === undefined) return
    await this.d.bot
      .api('editMessageText', { message_id: messageId, text, reply_markup: tasti ? this.tasti(id) : { inline_keyboard: [] } })
      .catch((e: unknown) => {
        if (!(e instanceof Error && /not modified/i.test(e.message))) this.log(`messaggio non aggiornato: ${e instanceof Error ? e.message : String(e)}`)
      })
  }

  async callback(data: string, ctx: Parameters<NonNullable<BotExtension['callback']>>[1]): Promise<boolean> {
    const m = /^rev:(pub|del|delok|no):(.+)$/.exec(data)
    if (!m) return false
    const [, action, id] = m
    const e = this.d.programs.episode(id)
    if (!e || e.status !== 'bozza') {
      await ctx.answer(e ? 'Questa puntata non è più da rivedere' : 'Puntata non più in archivio', true)
      if (ctx.messageId !== undefined) await this.d.bot.api('editMessageReplyMarkup', { message_id: ctx.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      return true
    }
    const name = ctx.by.replace(/^Telegram: /, '')
    if (action === 'del') {
      await ctx.answer()
      if (ctx.messageId !== undefined) {
        await this.d.bot.api('editMessageReplyMarkup', {
          message_id: ctx.messageId,
          reply_markup: { inline_keyboard: [[{ text: '🗑 Sì, elimina per sempre', callback_data: `rev:delok:${id}` }, { text: '↩ No', callback_data: `rev:no:${id}` }]] }
        }).catch(() => {})
      }
      return true
    }
    if (action === 'no') {
      await ctx.answer()
      if (ctx.messageId !== undefined) await this.d.bot.api('editMessageReplyMarkup', { message_id: ctx.messageId, reply_markup: this.tasti(id) }).catch(() => {})
      return true
    }
    if (action === 'delok') {
      const text = this.testo(e)
      this.d.programs.removeEpisode(id)
      this.log(`${ctx.by} ha eliminato la puntata ${e.title}`)
      await ctx.answer('Eliminata')
      await this.aggiorna(ctx.messageId, `${text}\n\n🗑 Eliminata da ${name}.`, false, id)
      return true
    }
    // pubblica
    const cut = e.cut ?? { from: 0, to: e.length }
    try {
      const done = await this.d.publish(id, { from: cut.from, to: cut.to, title: e.title, description: e.description })
      this.log(`${ctx.by} ha pubblicato ${e.title}`)
      await ctx.answer(done.status === 'elaborazione' ? 'Passa in Stereo Tool, poi si pubblica da sola' : 'Pubblicata')
      await this.aggiorna(
        ctx.messageId,
        `${this.testo(e)}\n\n${done.status === 'elaborazione' ? `⏳ ${name} l'ha pubblicata: passa in Stereo Tool, poi sarà ascoltabile.` : `✅ Pubblicata da ${name}.`}`,
        false,
        id
      )
    } catch (err) {
      await ctx.answer(`Non pubblicata: ${err instanceof Error ? err.message : String(err)}`, true)
    }
    return true
  }

  async reply(replyTo: number, text: string, ctx: Parameters<NonNullable<BotExtension['reply']>>[2]): Promise<boolean> {
    const id = this.state.messages[String(replyTo)]
    if (!id) return false
    const e = this.d.programs.episode(id)
    if (!e || e.status !== 'bozza') {
      await ctx.reply('Questa puntata non è più da rivedere.')
      return true
    }
    const t = leggiTaglio(text)
    if (!t) {
      await ctx.reply('Non ho capito: scrivi per esempio "inizio 0:02:10 fine 1:01:30" (ore:minuti:secondi).')
      return true
    }
    const cur = e.cut ?? { from: 0, to: e.length }
    const from = t.from ?? cur.from
    const to = Math.min(t.to ?? cur.to, e.length || Infinity)
    if (!(to - from >= 10)) {
      await ctx.reply(`Non va: la puntata deve durare almeno 10 secondi e finire entro ${hms(e.length)}.`)
      return true
    }
    const upd = this.d.programs.patchEpisode(id, { cut: { from, to } })
    await this.aggiorna(replyTo, this.testo(upd), true, id)
    await ctx.reply(`✂️ Ok: da ${hms(from)} a ${hms(to)}. Premi ✅ Pubblica sul messaggio quando va bene.`)
    return true
  }
}
