import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backupDue, PonteClient } from '../src/core/ponteClient'

const TOKEN = 'token-di-prova-abbastanza-lungo'
const port = 30000 + Math.floor(Math.random() * 10000)
let server: ChildProcess

beforeAll(async () => {
  server = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './ponte/controllo/prove/chiave-prove.mjs', 'ponte/controllo/src/server.ts'], {
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
    expect(await client.heartbeat({ mode: 'auto' })).toEqual({ alarms: [], maxTrackMinutes: 10 })
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

describe('backup automatico', () => {
  it('se non riesce non si riprova a ogni segnale di vita (15 s), ma dopo un po\'', async () => {
    const { vi } = await import('vitest')
    const { PonteService } = await import('../src/main/ponte')
    const { DEFAULT_PONTE } = await import('../src/core/types')
    const hb = vi.spyOn(PonteClient.prototype, 'heartbeat').mockResolvedValue({ alarms: [], maxTrackMinutes: null })
    const up = vi.spyOn(PonteClient.prototype, 'uploadBackup').mockRejectedValue(new Error('ponte non raggiungibile'))
    const db = { backupTo: (p: string) => writeFileSync(p, 'SQLite format 3\0') }
    const svc = new PonteService(db as never, mkdtempSync(join(tmpdir(), 'regia-')), null)
    try {
      svc.applySettings({ ...DEFAULT_PONTE, host: '127.0.0.1', controlToken: 'x', remoteControl: false, backupHour: 0 })
      const tick = (): Promise<void> => (svc as unknown as { tick: () => Promise<void> }).tick()
      await tick()
      await tick()
      await tick()
      expect(up).toHaveBeenCalledTimes(1)
      expect(svc.getStatus().backupError).toMatch(/non raggiungibile/)
    } finally {
      svc.stop()
      hb.mockRestore()
      up.mockRestore()
    }
  })
})
