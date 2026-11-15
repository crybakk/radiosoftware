import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scryptSync } from 'node:crypto'
import { can, sameSecret, Users } from './users.ts'

function make(now = () => Date.now()) {
  const d = mkdtempSync(join(tmpdir(), 'utenti-'))
  return { users: new Users(join(d, 'u.json'), join(d, 's.json'), now), dir: d }
}

describe('utenti del pannello', () => {
  it('accesso con password giusta, rifiuto con quella sbagliata', async () => {
    const { users } = make()
    users.save('cristian', 'amministratore', 'password-lunga')
    expect(await users.login('cristian', 'sbagliata')).toBeNull()
    expect(await users.login('nessuno', 'password-lunga')).toBeNull()
    const s = (await users.login('Cristian', 'password-lunga'))!
    expect(s.user).toEqual({ name: 'cristian', role: 'amministratore' })
    expect(users.session(s.token)?.name).toBe('cristian')
    users.logout(s.token)
    expect(users.session(s.token)).toBeNull()
  })

  it('i dati restano dopo un riavvio', async () => {
    const { users, dir } = make()
    users.save('anna', 'conduttore', 'password-anna')
    const s = (await users.login('anna', 'password-anna'))!
    const again = new Users(join(dir, 'u.json'), join(dir, 's.json'))
    expect(again.session(s.token)?.role).toBe('conduttore')
  })

  it('le sessioni scadono e si chiudono cambiando password', async () => {
    let t = 0
    const { users } = make(() => t)
    users.save('anna', 'conduttore', 'password-anna')
    const s1 = (await users.login('anna', 'password-anna'))!
    users.save('anna', 'conduttore', 'nuova-password')
    expect(users.session(s1.token)).toBeNull()
    const s2 = (await users.login('anna', 'nuova-password'))!
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

  it('codici di sessione come "constructor" o "__proto__" non sono sessioni', () => {
    const { users } = make()
    users.save('admin', 'amministratore', 'password-admin')
    for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(users.session(t)).toBeNull()
  })

  it('file di utenti e sessioni malformati non bloccano la partenza', () => {
    const d = mkdtempSync(join(tmpdir(), 'utenti-'))
    writeFileSync(join(d, 'u.json'), JSON.stringify({ non: 'una lista' }))
    writeFileSync(join(d, 's.json'), JSON.stringify({ a: null, b: 3, c: { user: 5, expires: 'x' } }))
    const users = new Users(join(d, 'u.json'), join(d, 's.json'))
    expect(users.count()).toBe(0)
    for (const t of ['a', 'b', 'c', 'constructor']) expect(users.session(t)).toBeNull()
    writeFileSync(join(d, 'u.json'), JSON.stringify([null, 7, { name: 'x' }, { name: 'anna', role: 'conduttore', hash: 'h', salt: 's' }]))
    expect(new Users(join(d, 'u.json'), join(d, 's.json')).list()).toEqual([{ name: 'anna', role: 'conduttore' }])
  })

  it("le password salvate prima restano valide (stesso formato dell'hash)", async () => {
    const d = mkdtempSync(join(tmpdir(), 'utenti-'))
    const salt = 'abcdef0123456789'
    const hash = scryptSync('password-vecchia', salt, 32).toString('hex')
    writeFileSync(join(d, 'u.json'), JSON.stringify([{ name: 'anna', role: 'conduttore', hash, salt }]))
    const users = new Users(join(d, 'u.json'), join(d, 's.json'))
    expect((await users.login('anna', 'password-vecchia'))?.user.name).toBe('anna')
  })

  it('confronto dei segreti', () => {
    expect(sameSecret('abc', 'abc')).toBe(true)
    expect(sameSecret('abc', 'abd')).toBe(false)
    expect(sameSecret('abc', 'abcd')).toBe(false)
  })
})
