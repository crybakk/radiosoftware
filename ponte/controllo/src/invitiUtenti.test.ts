import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INVITE_DAYS, MAX_INVITES, UserInvites } from './invitiUtenti.ts'
import { Users } from './users.ts'

function make(now = () => Date.now()) {
  const d = mkdtempSync(join(tmpdir(), 'inviti-'))
  const users = new Users(join(d, 'u.json'), join(d, 's.json'), now)
  users.save('admin', 'amministratore', 'password-admin')
  return { users, invites: new UserInvites(join(d, 'i.json'), users, now), file: join(d, 'i.json'), d }
}

describe('inviti per nuovi utenti', () => {
  it("chi ha il link sceglie la password, entra subito e poi accede con quella", async () => {
    const { users, invites } = make()
    const inv = invites.create('Mario', 'conduttore', 'admin')
    expect(invites.find(inv.token)).toMatchObject({ name: 'Mario', role: 'conduttore', by: 'admin' })
    const s = invites.accept(inv.token, 'password-mario')!
    expect(s.user).toEqual({ name: 'Mario', role: 'conduttore' })
    expect(users.session(s.token)?.name).toBe('Mario')
    expect((await users.login('mario', 'password-mario'))?.user.name).toBe('Mario')
  })

  it('il link vale una volta sola', () => {
    const { invites } = make()
    const inv = invites.create('mario', 'ospite', 'admin')
    expect(invites.accept(inv.token, 'password-1')).not.toBeNull()
    expect(invites.find(inv.token)).toBeNull()
    expect(invites.accept(inv.token, 'password-2')).toBeNull()
  })

  it(`scade dopo ${INVITE_DAYS} giorni`, () => {
    let t = 1_000_000
    const { invites } = make(() => t)
    const inv = invites.create('mario', 'ospite', 'admin')
    t += INVITE_DAYS * 86_400_000 - 1
    expect(invites.find(inv.token)).not.toBeNull()
    t += 1
    expect(invites.find(inv.token)).toBeNull()
    expect(invites.accept(inv.token, 'password-1')).toBeNull()
    expect(invites.list()).toEqual([])
  })

  it('annullato non funziona più', () => {
    const { invites } = make()
    const inv = invites.create('mario', 'ospite', 'admin')
    invites.revoke(inv.token)
    expect(invites.accept(inv.token, 'password-1')).toBeNull()
  })

  it('password corta: errore e il link resta valido', () => {
    const { invites } = make()
    const inv = invites.create('mario', 'ospite', 'admin')
    expect(() => invites.accept(inv.token, 'corta')).toThrow(/8 caratteri/)
    expect(invites.find(inv.token)).not.toBeNull()
  })

  it('niente inviti per nomi già usati, doppi o non validi', () => {
    const { invites } = make()
    expect(() => invites.create('Admin', 'ospite', 'admin')).toThrow(/già un utente/)
    invites.create('mario', 'ospite', 'admin')
    expect(() => invites.create('MARIO', 'conduttore', 'admin')).toThrow(/già un invito/)
    expect(() => invites.create('a', 'ospite', 'admin')).toThrow(/Nome non valido/)
    expect(() => invites.create('luca', 'capo' as never, 'admin')).toThrow(/Ruolo/)
  })

  it("se nel frattempo l'utente è stato creato a mano l'invito sparisce", () => {
    const { users, invites } = make()
    const inv = invites.create('mario', 'ospite', 'admin')
    users.save('mario', 'conduttore', 'password-a-mano')
    expect(invites.list()).toEqual([])
    expect(invites.accept(inv.token, 'password-altra')).toBeNull()
    expect(users.get('mario')?.role).toBe('conduttore')
  })

  it(`al massimo ${MAX_INVITES} inviti in attesa`, () => {
    const { invites } = make()
    for (let i = 0; i < MAX_INVITES; i++) invites.create(`utente${i}`, 'ospite', 'admin')
    expect(() => invites.create('unaltro', 'ospite', 'admin')).toThrow(/annullane/)
  })

  it('gli inviti restano dopo un riavvio; file rovinato: si riparte senza', () => {
    const { users, invites, file, d } = make()
    const inv = invites.create('mario', 'ospite', 'admin')
    expect(new UserInvites(file, users).find(inv.token)?.name).toBe('mario')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1)
    writeFileSync(file, '{rotto')
    expect(new UserInvites(file, users, undefined).list()).toEqual([])
    writeFileSync(join(d, 'x.json'), JSON.stringify([{ token: 'a', name: 'x', role: 'capo' }, null]))
    expect(new UserInvites(join(d, 'x.json'), users).list()).toEqual([])
  })
  it("gli inviti di un amministratore eliminato o declassato si annullano", () => {
    const { invites } = make()
    const a = invites.create('mario', 'amministratore', 'Admin')
    const b = invites.create('luca', 'ospite', 'altro')
    expect(invites.revokeBy('admin')).toBe(1)
    expect(invites.find(a.token)).toBeNull()
    expect(invites.find(b.token)?.name).toBe('luca')
    expect(invites.accept(a.token, 'password-lunga')).toBeNull()
  })
})
