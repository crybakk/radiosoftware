/** Invio delle notifiche: Telegram e/o email, secondo quello che è configurato. */
import nodemailer from 'nodemailer'

export interface NotifierConfig {
  telegramToken: string
  telegramChatId: string
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPassword: string
  smtpSecure: boolean
  emailFrom: string
  emailTo: string
  stationName: string
}

export class Notifier {
  private mailer: ReturnType<typeof nodemailer.createTransport> | null = null
  private c: NotifierConfig

  constructor(c: NotifierConfig) {
    this.c = c
    if (c.smtpHost && c.emailTo) {
      this.mailer = nodemailer.createTransport({
        host: c.smtpHost,
        port: c.smtpPort,
        secure: c.smtpSecure,
        auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPassword } : undefined
      })
    }
  }

  channels(): string[] {
    const out: string[] = []
    if (this.c.telegramToken && this.c.telegramChatId) out.push('telegram')
    if (this.mailer) out.push('email')
    return out
  }

  async send(text: string): Promise<{ channel: string; ok: boolean; error?: string }[]> {
    const full = `${this.c.stationName}: ${text}`
    const results: { channel: string; ok: boolean; error?: string }[] = []
    if (this.c.telegramToken && this.c.telegramChatId) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${this.c.telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.c.telegramChatId, text: full }),
          signal: AbortSignal.timeout(10_000)
        })
        results.push({ channel: 'telegram', ok: r.ok, error: r.ok ? undefined : `HTTP ${r.status}` })
      } catch (e) {
        results.push({ channel: 'telegram', ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (this.mailer) {
      try {
        await this.mailer.sendMail({
          from: this.c.emailFrom || this.c.smtpUser,
          to: this.c.emailTo,
          subject: `[${this.c.stationName}] ${text.slice(0, 80)}`,
          text: `${full}\n\n${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`
        })
        results.push({ channel: 'email', ok: true })
      } catch (e) {
        results.push({ channel: 'email', ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    for (const r of results) if (!r.ok) console.error(`[notifica] ${r.channel} non inviata: ${r.error}`)
    return results
  }
}
