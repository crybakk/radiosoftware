/** Utenti del pannello remoto, ruoli e sessioni. Tutto salvato in file JSON nella cartella dati. */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export type Role = 'amministratore' | 'conduttore' | 'ospite'
export const ROLES: Role[] = ['amministratore', 'conduttore', 'ospite']

export interface User {
  name: string
  role: Role
  hash: string
  salt: string
}

export interface PublicUser {
  name: string
  role: Role
}

interface Session {
  user: string
  expires: number
}

const SESSION_DAYS = 30

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString('hex')
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

export function validName(name: string): boolean {
  return /^[\p{L}\p{N}._-]{2,32}$/u.test(name)
}

export class Users {
  private users: User[]
  private sessions: Record<string, Session>
  private usersFile: string
  private sessionsFile: string
  private now: () => number

  constructor(usersFile: string, sessionsFile: string, now: () => number = () => Date.now()) {
    this.usersFile = usersFile
    this.sessionsFile = sessionsFile
    this.now = now
    this.users = readJson<User[]>(usersFile, [])
    this.sessions = readJson<Record<string, Session>>(sessionsFile, {})
  }

  count(): number {
    return this.users.length
  }

  list(): PublicUser[] {
    return this.users.map((u) => ({ name: u.name, role: u.role })).sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): PublicUser | null {
    const u = this.users.find((x) => x.name.toLowerCase() === name.toLowerCase())
    return u ? { name: u.name, role: u.role } : null
  }

  /** Crea o aggiorna un utente. La password è obbligatoria solo per un utente nuovo. */
  save(name: string, role: Role, password?: string): PublicUser {
    if (!validName(name)) throw new Error('Nome non valido: da 2 a 32 lettere, numeri, punto, trattino')
    if (!ROLES.includes(role)) throw new Error('Ruolo non valido')
    if (password !== undefined && password !== '' && password.length < 8) throw new Error('La password deve avere almeno 8 caratteri')
    const existing = this.users.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!existing && !password) throw new Error('Serve una password')
    if (existing && existing.role === 'amministratore' && role !== 'amministratore' && this.admins() === 1) {
      throw new Error("Deve restare almeno un amministratore")
    }
    const user = existing ?? { name, role, hash: '', salt: '' }
    user.role = role
    if (password) {
      user.salt = randomBytes(16).toString('hex')
      user.hash = hashPassword(password, user.salt)
      // cambiando password si chiudono le sessioni aperte
      this.dropSessions(user.name)
    }
    if (!existing) this.users.push(user)
    writeJson(this.usersFile, this.users)
    return { name: user.name, role: user.role }
  }

  remove(name: string): void {
    const u = this.users.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!u) return
    if (u.role === 'amministratore' && this.admins() === 1) throw new Error('Deve restare almeno un amministratore')
    this.users = this.users.filter((x) => x !== u)
    this.dropSessions(u.name)
    writeJson(this.usersFile, this.users)
  }

  private admins(): number {
    return this.users.filter((u) => u.role === 'amministratore').length
  }

  /** Controlla nome e password; se vanno bene apre una sessione e ne restituisce il codice. */
  login(name: string, password: string): { token: string; user: PublicUser } | null {
    const u = this.users.find((x) => x.name.toLowerCase() === name.toLowerCase())
    // anche con un nome inesistente facciamo il calcolo, per non far capire quali nomi esistono
    const salt = u?.salt ?? 'x'
    const got = Buffer.from(hashPassword(password, salt), 'hex')
    const want = Buffer.from(u?.hash ?? '0'.repeat(64), 'hex')
    if (!u || got.length !== want.length || !timingSafeEqual(got, want)) return null
    const token = randomBytes(32).toString('hex')
    this.purge()
    this.sessions[token] = { user: u.name, expires: this.now() + SESSION_DAYS * 86_400_000 }
    writeJson(this.sessionsFile, this.sessions)
    return { token, user: { name: u.name, role: u.role } }
  }

  logout(token: string): void {
    if (!this.sessions[token]) return
    delete this.sessions[token]
    writeJson(this.sessionsFile, this.sessions)
  }

  /** Utente della sessione, se valida. */
  session(token: string | undefined): PublicUser | null {
    if (!token) return null
    const s = this.sessions[token]
    if (!s || s.expires < this.now()) return null
    return this.get(s.user)
  }

  private dropSessions(name: string): void {
    let changed = false
    for (const [t, s] of Object.entries(this.sessions)) {
      if (s.user.toLowerCase() === name.toLowerCase()) {
        delete this.sessions[t]
        changed = true
      }
    }
    if (changed) writeJson(this.sessionsFile, this.sessions)
  }

  private purge(): void {
    const t = this.now()
    for (const [k, s] of Object.entries(this.sessions)) if (s.expires < t) delete this.sessions[k]
  }
}

/** Cosa può fare ogni ruolo. */
export function can(role: Role, action: 'vedere' | 'comandare' | 'utenti'): boolean {
  if (action === 'vedere') return true
  if (action === 'comandare') return role === 'amministratore' || role === 'conduttore'
  return role === 'amministratore'
}
