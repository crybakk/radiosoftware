/**
 * Ospiti collegati con un link: sala d'attesa, ingresso deciso dal conduttore, in onda / fuori onda.
 *
 * - Un conduttore crea un link (valido 24 ore, revocabile) e lo manda all'ospite.
 * - L'ospite apre il link, scrive il nome e aspetta: nel pannello compare "in attesa".
 * - Il conduttore lo fa entrare: l'ospite riceve un posto audio (massimo 3 insieme), si collega
 *   in WebRTC e sente il programma con le altre voci, senza la propria.
 * - Il conduttore lo mette in onda, lo toglie, lo chiude. Se lo caccia, il link usato si revoca
 *   (un link vale per più ospiti, ma chi è stato cacciato non rientra con quello).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { GuestCommand, GuestInfo, GuestInvite } from './protocol.ts'
import type { Peer } from './relay.ts'
import type { VoiceHub } from './voce.ts'
import { setAsideBroken } from './statoFile.ts'

const INVITE_HOURS = 24
const MAX_WAITING = 10

/** Messaggi pagina dell'ospite → ponte */
export type FromGuest = { t: 'join'; name: string } | { t: 'rtc-offer'; id: string; sdp: string } | { t: 'leave' }

/** Ponte → pagina dell'ospite */
export type ToGuest =
  | { t: 'hello'; label: string; station: string; listenUrl: string }
  | { t: 'state'; state: 'attesa' | 'dentro' | 'rifiutato' | 'chiuso' | 'pieno'; onAir: boolean }
  | { t: 'reply'; id: string; ok: boolean; data?: unknown; error?: string }

interface Guest {
  id: string
  name: string
  peer: Peer
  invite: GuestInvite
  state: 'attesa' | 'dentro'
  slot: VoiceHub | null
  since: number
}

export interface GuestOptions {
  file: string
  slots: VoiceHub[]
  station: string
  listenUrl: string
  now?: () => number
}

export class Guests {
  private invites = new Map<string, GuestInvite>()
  private guests = new Map<string, Guest>()
  private seq = 0
  onChange: (list: GuestInfo[]) => void = () => {}
  private readonly o: GuestOptions
  private readonly now: () => number

  constructor(o: GuestOptions) {
    this.o = o
    this.now = o.now ?? (() => Date.now())
    if (existsSync(o.file)) {
      try {
        for (const i of JSON.parse(readFileSync(o.file, 'utf8')) as GuestInvite[]) this.invites.set(i.token, i)
      } catch (e) {
        // file rovinato: si riparte senza link (il file si copia da parte)
        setAsideBroken(o.file, e)
      }
    }
    for (const s of o.slots) s.onChange = () => this.emit()
  }

  private save(): void {
    const tmp = `${this.o.file}.tmp`
    writeFileSync(tmp, JSON.stringify([...this.invites.values()]), { mode: 0o600 })
    renameSync(tmp, this.o.file)
  }

  private prune(): void {
    const t = this.now()
    let changed = false
    for (const [k, i] of this.invites) {
      if (Date.parse(i.expiresAt) <= t) {
        this.invites.delete(k)
        changed = true
      }
    }
    if (changed) this.save()
  }

  validInvite(token: string | null | undefined): GuestInvite | null {
    if (!token) return null
    this.prune()
    return this.invites.get(token) ?? null
  }

  listInvites(): GuestInvite[] {
    this.prune()
    return [...this.invites.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  list(): GuestInfo[] {
    return [...this.guests.values()].map((g) => ({
      id: g.id,
      name: g.name,
      label: g.invite.label,
      state: g.state,
      onAir: g.slot?.status().onAir ?? false,
      connected: !!g.slot && g.slot.status().user !== null,
      since: new Date(g.since).toISOString()
    }))
  }

  /** Comandi del conduttore dal pannello. */
  async command(cmd: GuestCommand, by: string): Promise<unknown> {
    switch (cmd.type) {
      case 'invite': {
        const label = String(cmd.label ?? '').trim().slice(0, 60)
        const t = this.now()
        const inv: GuestInvite = {
          token: randomBytes(18).toString('base64url'),
          label,
          by,
          createdAt: new Date(t).toISOString(),
          expiresAt: new Date(t + INVITE_HOURS * 3600_000).toISOString()
        }
        this.invites.set(inv.token, inv)
        this.save()
        return inv
      }
      case 'invites':
        return this.listInvites()
      case 'revoke': {
        this.invites.delete(String(cmd.token))
        this.save()
        // chi è entrato con quel link viene chiuso
        for (const g of [...this.guests.values()]) if (g.invite.token === cmd.token) this.drop(g, 'chiuso')
        return this.listInvites()
      }
      case 'admit': {
        const g = this.get(cmd.id)
        if (g.state === 'dentro') return null
        const slot = this.o.slots.find((s) => s.status().user === null && ![...this.guests.values()].some((x) => x.slot === s))
        if (!slot) throw new Error(`ci sono già ${this.o.slots.length} ospiti collegati: chiudine uno prima`)
        g.slot = slot
        g.state = 'dentro'
        this.send(g, { t: 'state', state: 'dentro', onAir: false })
        this.emit()
        return null
      }
      case 'reject':
        this.drop(this.get(cmd.id), 'rifiutato')
        return null
      case 'kick': {
        const g = this.get(cmd.id)
        this.drop(g, 'chiuso')
        // chi viene cacciato non deve poter rientrare con lo stesso link: il link si revoca
        // (gli altri ospiti già collegati con quel link restano dentro)
        if (this.invites.delete(g.invite.token)) this.save()
        return null
      }
      case 'air': {
        const g = this.get(cmd.id)
        if (!g.slot) throw new Error("l'ospite è ancora in sala d'attesa")
        if (g.slot.status().user === null) throw new Error("l'audio dell'ospite non è ancora collegato")
        await g.slot.setMic(g.peer, cmd.on === true)
        this.send(g, { t: 'state', state: 'dentro', onAir: cmd.on === true })
        return null
      }
      default:
        throw new Error('comando sconosciuto')
    }
  }

  private get(id: string): Guest {
    const g = this.guests.get(String(id))
    if (!g) throw new Error("l'ospite non è più collegato")
    return g
  }

  /** Nuova pagina dell'ospite (link già controllato). */
  attach(peer: Peer, invite: GuestInvite, host?: string): { message: (raw: string) => void; close: () => void } {
    let guest: Guest | null = null
    this.sendTo(peer, { t: 'hello', label: invite.label, station: this.o.station, listenUrl: this.o.listenUrl })
    return {
      message: (raw: string) => {
        let msg: FromGuest
        try {
          msg = JSON.parse(raw) as FromGuest
        } catch {
          return
        }
        if (!msg || typeof msg !== 'object') return
        if (msg.t === 'join' && !guest) {
          if (!this.validInvite(invite.token)) return this.sendTo(peer, { t: 'state', state: 'chiuso', onAir: false })
          if ([...this.guests.values()].filter((g) => g.state === 'attesa').length >= MAX_WAITING) {
            // sala piena: si avvisa e si chiude la connessione (si riprova riaprendo il link)
            this.sendTo(peer, { t: 'state', state: 'pieno', onAir: false })
            return peer.close(1000, 'pieno')
          }
          const name = String(msg.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || invite.label || 'Ospite'
          guest = { id: `o${++this.seq}`, name, peer, invite, state: 'attesa', slot: null, since: this.now() }
          this.guests.set(guest.id, guest)
          this.sendTo(peer, { t: 'state', state: 'attesa', onAir: false })
          this.emit()
          return
        }
        if (msg.t === 'rtc-offer' && guest) {
          const g = guest
          const reply = (ok: boolean, data?: unknown, error?: string): void =>
            this.sendTo(peer, { t: 'reply', id: String(msg.id), ok, data, error })
          if (!g.slot) return reply(false, undefined, 'aspetta che il conduttore ti faccia entrare')
          g.slot
            .open(peer, `ospite: ${g.name}`, String(msg.sdp), host)
            .then((sdp) => {
              reply(true, { sdp })
              this.emit()
            })
            .catch((e: unknown) => reply(false, undefined, e instanceof Error ? e.message : String(e)))
          return
        }
        if (msg.t === 'leave' && guest) {
          this.drop(guest, 'chiuso')
          guest = null
        }
      },
      close: () => {
        if (guest && this.guests.get(guest.id) === guest) this.drop(guest, null)
        guest = null
      }
    }
  }

  private drop(g: Guest, state: 'rifiutato' | 'chiuso' | null): void {
    g.slot?.close(g.peer)
    g.slot = null
    this.guests.delete(g.id)
    if (state) {
      this.send(g, { t: 'state', state, onAir: false })
      g.peer.close(1000, state)
    }
    this.emit()
  }

  private send(g: Guest, m: ToGuest): void {
    this.sendTo(g.peer, m)
  }

  private sendTo(peer: Peer, m: ToGuest): void {
    try {
      peer.send(JSON.stringify(m))
    } catch {
      // connessione già chiusa
    }
  }

  private emit(): void {
    this.onChange(this.list())
  }
}
