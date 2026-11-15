import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { can, Users } from './users.ts'

function make(now = () => Date.now()) {
  const d = mkdtempSync(join(tmpdir(), 'utenti-'))
  return { users: new Users(join(d, 'u.json'), join(d, 's.json'), now), dir: d }
}

describe('utenti del pannello', () => {
  it('accesso con password giusta, rifiuto con quella sbagliata', () => {
    const { users } = make()
    users.save('cristian', 'amministratore', 'password-lunga')
    expect(users.login('cristian', 'sbagliata')).toBeNull()
    expect(users.login('nessuno', 'password-lunga')).toBeNull()
    const s = users.login('Cristian', 'password-lunga')!
    expect(s.user).toEqual({ name: 'cristian', role: 'amministratore' })
    expect(users.session(s.token)?.name).toBe('cristian')
    users.logout(s.token)
    expect(users.session(s.token)).toBeNull()
  })

  it('i dati restano dopo un riavvio', () => {
    const { users, dir } = make()
    users.save('anna', 'conduttore', 'password-anna')
    const s = users.login('anna', 'password-anna')!
    const again = new Users(join(dir, 'u.json'), join(dir, 's.json'))
    expect(again.session(s.token)?.role).toBe('conduttore')
  })

  it('le sessioni scadono e si chiudono cambiando password', () => {
    let t = 0
    const { users } = make(() => t)
    users.save('anna', 'conduttore', 'password-anna')
    const s1 = users.login('anna', 'password-anna')!
    users.save('anna', 'conduttore', 'nuova-password')
    expect(users.session(s1.token)).toBeNull()
    const s2 = users.login('anna', 'nuova-password')!
    t += 31 * 86_400_000
    expect(users.session(s2.token)).toBeNull()
  })

  it('regole: almeno un amministratore, password lunga, nome valido', () => {
    const { users } = make()
    users.save('admin', 'amministratore', 'password-admin')
    expect(() => users.remove('admin')).toThrow('almeno un amministratore')
    expect(() => users.save('admin', 'conduttore')).toThrow('almeno un amministratore')
    expect(() => users.save('x', 'ospite', 'password-ok')).toThrow('Nome non valido')
    expect(() => users.save('ospite1', 'ospite', 'corta')).toThrow('almeno 8')
    expect(() => users.save('ospite1', 'ospite')).toThrow('Serve una password')
  })

  it('permessi per ruolo', () => {
    expect(can('ospite', 'comandare')).toBe(false)
    expect(can('conduttore', 'comandare')).toBe(true)
    expect(can('conduttore', 'utenti')).toBe(false)
    expect(can('amministratore', 'utenti')).toBe(true)
  })
})
