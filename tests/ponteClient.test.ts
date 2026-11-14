import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backupDue, PonteClient } from '../src/core/ponteClient'

const TOKEN = 'token-di-prova-abbastanza-lungo'
const port = 30000 + Math.floor(Math.random() * 10000)
let server: ChildProcess

beforeAll(async () => {
  server = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'ponte/controllo/src/server.ts'], {
    env: {
      ...process.env,
      CONTROLLO_TOKEN: TOKEN,
      CONTROLLO_PORTA: String(port),
      CONTROLLO_PORTA_INTERNA: String(port + 1),
      CARTELLA_DATI: mkdtempSync(join(tmpdir(), 'ponte-')),
      LIQUIDSOAP_INTERNO: 'http://127.0.0.1:1'
    },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  await new Promise<void>((resolve) => server.stdout!.on('data', (d: Buffer) => String(d).includes('Controllo in ascolto') && resolve()))
})
afterAll(() => server.kill())

describe('client del ponte', () => {
  const client = new PonteClient('127.0.0.1', port, TOKEN)

  it('segnale di vita e stato', async () => {
    expect(await client.heartbeat({ mode: 'auto' })).toEqual([])
    const st = await client.state()
    expect(st.lastHeartbeat).not.toBeNull()
    expect(st.notifiche).toEqual([])
  })

  it('token errato: messaggio chiaro', async () => {
    await expect(new PonteClient('127.0.0.1', port, 'sbagliato').state()).rejects.toThrow('token del ponte errato')
  })

  it('ponte spento: messaggio chiaro', async () => {
    await expect(new PonteClient('127.0.0.1', 1, TOKEN).state()).rejects.toThrow('ponte non raggiungibile')
  })

  it('backup: invio, elenco e scaricamento identico', async () => {
    const data = new Uint8Array(5000).map((_, i) => i % 251)
    const name = await client.uploadBackup(data)
    expect(name).toMatch(/^radio-.*\.db$/)
    expect((await client.listBackups()).map((b) => b.name)).toContain(name)
    expect(Buffer.from(await client.downloadBackup(name)).equals(Buffer.from(data))).toBe(true)
  })

  it('titoli: se Liquidsoap non risponde segnala errore', async () => {
    await expect(client.metadata('Lucio Battisti', 'Emozioni')).rejects.toThrow()
  })
})

describe('orario del backup', () => {
  const at = (h: number, m = 0, d = 14) => new Date(2026, 10, d, h, m)
  it('una volta al giorno dopo l\'ora scelta', () => {
    expect(backupDue(at(3, 59), 4, null)).toBe(false)
    expect(backupDue(at(4, 0), 4, null)).toBe(true)
    expect(backupDue(at(10), 4, at(4, 1))).toBe(false)
    expect(backupDue(at(10), 4, at(23, 0, 13))).toBe(true)
    expect(backupDue(at(10), -1, null)).toBe(false)
  })
})
