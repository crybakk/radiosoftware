/** Utenti del pannello remoto, ruoli e sessioni. Tutto salvato in file JSON nella cartella dati. */
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { setAsideBroken } from './statoFile.ts'

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>

export type Role = 'amministratore' | 'conduttore' | 'ospite'
export const ROLES: Role[] = ['amministratore', 'conduttore', 'ospite']

export interface User {
  name: string
  role: Role
  hash: string
  salt: string
  /** non ha ancora visto il benvenuto del pannello (solo utenti creati dopo il 19/11/2026) */
  nuovo?: boolean
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
/** Sessioni aperte al massimo per ogni utente: oltre, si chiude la più vecchia. */
export const MAX_SESSIONS_PER_USER = 20
/** Sessioni aperte al massimo in tutto. */
export const MAX_SESSIONS = 500

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString('hex')
}

/** Stesso formato di hashPassword, ma senza bloccare il server durante il calcolo. */
async function hashPasswordAsync(password: string, salt: string): Promise<string> {
  return (await scryptAsync(password, salt, 32)).toString('hex')
}

/** Confronto di due segreti in tempo costante (anche con lunghezze diverse). */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined // file che non c'è ancora
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    // file rovinato: si riparte senza, ma prima lo si copia da parte
    setAsideBroken(path, e)
    return undefined
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Utenti letti dal file: si tengono solo le voci ben formate. */
function loadUsers(data: unknown): User[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (u): u is User =>
      isObject(u) &&
      typeof u.name === 'string' &&
      typeof u.hash === 'string' &&
      typeof u.salt === 'string' &&
      ROLES.includes(u.role as Role)
  )
}

/** Sessioni lette dal file, in una Map (niente sorprese con chiavi come "constructor"). */
function loadSessions(data: unknown): Map<string, Session> {
  const out = new Map<string, Session>()
  if (!isObject(data)) return out
  for (const [k, s] of Object.entries(data)) {
    if (isObject(s) && typeof s.user === 'string' && typeof s.expires === 'number') out.set(k, { user: s.user, expires: s.expires })
  }
  return out
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
  private sessions: Map<string, Session>
  private usersFile: string
  private sessionsFile: string
  private now: () => number

  constructor(usersFile: string, sessionsFile: string, now: () => number = () => Date.now()) {
    this.usersFile = usersFile
    this.sessionsFile = sessionsFile
    this.now = now
    this.users = loadUsers(readJson(usersFile))
    this.sessions = loadSessions(readJson(sessionsFile))
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
    const user: User = existing ?? { name, role, hash: '', salt: '', nuovo: true }
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

  /** Deve vedere il benvenuto del pannello (primo accesso)? */
  isNew(name: string): boolean {
    return this.users.find((x) => x.name.toLowerCase() === name.toLowerCase())?.nuovo === true
  }

  /** Benvenuto visto (o saltato): non si mostra più da solo. */
  welcomed(name: string): void {
    const u = this.users.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!u?.nuovo) return
    delete u.nuovo
    writeJson(this.usersFile, this.users)
  }

  private admins(): number {
    return this.users.filter((u) => u.role === 'amministratore').length
  }

  /** Controlla nome e password; se vanno bene apre una sessione e ne restituisce il codice. */
  async login(name: string, password: string): Promise<{ token: string; user: PublicUser } | null> {
    const u = this.users.find((x) => x.name.toLowerCase() === name.toLowerCase())
    // anche con un nome inesistente facciamo il calcolo, per non far capire quali nomi esistono
    const salt = u?.salt ?? 'x'
    const hash = u?.hash ?? '0'.repeat(64)
    const got = Buffer.from(await hashPasswordAsync(password, salt), 'hex')
    const want = Buffer.from(hash, 'hex')
    if (!u || got.length !== want.length || !timingSafeEqual(got, want)) return null
    // durante il calcolo l'utente può essere stato eliminato o aver cambiato password
    if (!this.users.includes(u) || u.hash !== hash) return null
    return this.openSession(u.name)!
  }

  /** Apre una sessione per un utente esistente (dopo l'accesso, o dopo aver accettato un invito). */
  openSession(name: string): { token: string; user: PublicUser } | null {
    const u = this.users.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!u) return null
    const token = randomBytes(32).toString('hex')
    this.purge()
    this.trim(u.name)
    this.sessions.set(token, { user: u.name, expires: this.now() + SESSION_DAYS * 86_400_000 })
    this.writeSessions()
    return { token, user: { name: u.name, role: u.role } }
  }

  logout(token: string): void {
    if (!this.sessions.delete(token)) return
    this.writeSessions()
  }

  /** Utente della sessione, se valida. */
  session(token: string | undefined): PublicUser | null {
    if (typeof token !== 'string' || !token) return null
    const s = this.sessions.get(token)
    if (!s || s.expires < this.now()) return null
    return this.get(s.user)
  }

  private writeSessions(): void {
    writeJson(this.sessionsFile, Object.fromEntries(this.sessions))
  }

  private dropSessions(name: string): void {
    let changed = false
    for (const [t, s] of this.sessions) {
      if (s.user.toLowerCase() === name.toLowerCase()) {
        this.sessions.delete(t)
        changed = true
      }
    }
    if (changed) this.writeSessions()
  }

  /** Fa posto a una nuova sessione: chiude le più vecchie dell'utente e, se serve, di tutti. */
  private trim(name: string): void {
    const byAge = (list: [string, Session][]) => list.sort((a, b) => a[1].expires - b[1].expires)
    const mine = byAge([...this.sessions].filter(([, s]) => s.user.toLowerCase() === name.toLowerCase()))
    for (const [t] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER + 1))) this.sessions.delete(t)
    if (this.sessions.size >= MAX_SESSIONS) {
      const all = byAge([...this.sessions])
      for (const [t] of all.slice(0, this.sessions.size - MAX_SESSIONS + 1)) this.sessions.delete(t)
    }
  }

  private purge(): void {
    const t = this.now()
    for (const [k, s] of this.sessions) if (s.expires < t) this.sessions.delete(k)
  }
}

/** Cosa può fare ogni ruolo. */
export function can(role: Role, action: 'vedere' | 'comandare' | 'utenti'): boolean {
  if (action === 'vedere') return true
  if (action === 'comandare') return role === 'amministratore' || role === 'conduttore'
  return role === 'amministratore'
}
