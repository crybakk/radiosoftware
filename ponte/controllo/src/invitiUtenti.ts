/**
 * Inviti per nuovi utenti del pannello (scelta di cristian, 19/11/2026: l'amministratore non imposta la password).
 *
 * - L'amministratore sceglie nome e ruolo e crea un link (valido 7 giorni, revocabile).
 * - Chi riceve il link lo apre, sceglie la sua password ed entra subito nel pannello.
 * - Il link vale una volta sola: usato, scaduto o annullato non funziona più.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { setAsideBroken } from './statoFile.ts'
import { ROLES, validName, type PublicUser, type Role, type Users } from './users.ts'

export const INVITE_DAYS = 7
/** Inviti in attesa al massimo, tutti insieme. */
export const MAX_INVITES = 50

export interface UserInvite {
  token: string
  name: string
  role: Role
  by: string
  createdAt: string
  expiresAt: string
}

const isInvite = (v: unknown): v is UserInvite => {
  if (typeof v !== 'object' || v === null) return false
  const i = v as Record<string, unknown>
  return (
    typeof i.token === 'string' &&
    typeof i.name === 'string' &&
    ROLES.includes(i.role as Role) &&
    typeof i.by === 'string' &&
    typeof i.createdAt === 'string' &&
    typeof i.expiresAt === 'string'
  )
}

export class UserInvites {
  private invites = new Map<string, UserInvite>()
  private readonly file: string
  private readonly users: Users
  private readonly now: () => number

  constructor(file: string, users: Users, now: () => number = () => Date.now()) {
    this.file = file
    this.users = users
    this.now = now
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as unknown
        if (Array.isArray(data)) for (const i of data) if (isInvite(i)) this.invites.set(i.token, i)
      } catch (e) {
        // file rovinato: si riparte senza inviti (il file si copia da parte)
        setAsideBroken(file, e)
      }
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify([...this.invites.values()], null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** Toglie gli inviti scaduti e quelli per nomi che nel frattempo sono diventati utenti. */
  private prune(): void {
    const t = this.now()
    let changed = false
    for (const [k, i] of this.invites) {
      if (Date.parse(i.expiresAt) <= t || this.users.get(i.name)) {
        this.invites.delete(k)
        changed = true
      }
    }
    if (changed) this.save()
  }

  list(): UserInvite[] {
    this.prune()
    return [...this.invites.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  create(name: string, role: Role, by: string): UserInvite {
    name = name.trim()
    if (!validName(name)) throw new Error('Nome non valido: da 2 a 32 lettere, numeri, punto, trattino')
    if (!ROLES.includes(role)) throw new Error('Ruolo non valido')
    if (this.users.get(name)) throw new Error(`C'è già un utente che si chiama ${name}`)
    this.prune()
    if ([...this.invites.values()].some((i) => i.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`C'è già un invito per ${name}: copia quello o annullalo`)
    }
    if (this.invites.size >= MAX_INVITES) throw new Error(`Ci sono già ${MAX_INVITES} inviti in attesa: annullane qualcuno`)
    const t = this.now()
    const inv: UserInvite = {
      token: randomBytes(24).toString('base64url'),
      name,
      role,
      by,
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + INVITE_DAYS * 86_400_000).toISOString()
    }
    this.invites.set(inv.token, inv)
    this.save()
    return inv
  }

  revoke(token: string): void {
    if (this.invites.delete(token)) this.save()
  }

  /**
   * Annulla gli inviti creati da un amministratore che è stato eliminato o non è più amministratore:
   * i suoi link non devono continuare a creare utenti (anche amministratori) al posto suo.
   */
  revokeBy(name: string): number {
    const n = name.toLowerCase()
    let removed = 0
    for (const [k, i] of this.invites) {
      if (i.by.toLowerCase() === n) {
        this.invites.delete(k)
        removed++
      }
    }
    if (removed) this.save()
    return removed
  }

  /** L'invito di un link, se è ancora valido. */
  find(token: string | null | undefined): UserInvite | null {
    if (typeof token !== 'string' || !token) return null
    this.prune()
    return this.invites.get(token) ?? null
  }

  /**
   * Chi ha ricevuto il link sceglie la password: si crea l'utente, il link non vale più e si apre la sessione.
   * Restituisce null se il link non è valido (scaduto, già usato, annullato).
   */
  accept(token: string, password: string): { token: string; user: PublicUser } | null {
    const inv = this.find(token)
    if (!inv) return null
    if (password.length < 8) throw new Error('La password deve avere almeno 8 caratteri')
    if (password.length > 200) throw new Error('Password troppo lunga')
    // il link si brucia prima di creare l'utente: due richieste insieme non creano due volte
    this.invites.delete(inv.token)
    this.save()
    this.users.save(inv.name, inv.role, password)
    return this.users.openSession(inv.name)
  }
}
