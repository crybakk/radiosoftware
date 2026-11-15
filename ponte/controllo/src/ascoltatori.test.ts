import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromAdminXml, fromStatusJson, ListenerLog, period, readSecondary, report } from './ascoltatori.ts'

const at = (s: string): number => new Date(s).getTime()

describe('statistiche degli ascoltatori', () => {
  it('salva un campione al minuto e rilegge per periodo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ascolt-'))
    const log = new ListenerLog(dir)
    log.add({ t: at('2026-11-16T10:00:10'), a: 5, b: 2 })
    log.add({ t: at('2026-11-16T10:00:50'), a: 9, b: 9 }) // stesso minuto: ignorato
    log.add({ t: at('2026-11-16T10:01:05'), a: 6, b: null })
    log.add({ t: at('2026-11-17T08:00:00'), a: 1, b: 0 })
    expect(log.read(at('2026-11-16T00:00'), at('2026-11-17T00:00'))).toEqual([
      { t: at('2026-11-16T10:00:00'), a: 5, b: 2 },
      { t: at('2026-11-16T10:01:00'), a: 6, b: null }
    ])
    expect(log.read(at('2026-11-16T00:00'), at('2026-11-18T00:00'))).toHaveLength(3)
    // un anno dopo il primo giorno se ne va
    writeFileSync(join(dir, '2025-01-01.jsonl'), '')
    log.prune(at('2026-11-17T12:00'))
    expect(readdirSync(dir).sort()).toEqual(['2026-11-16.jsonl', '2026-11-17.jsonl'])
  })

  it('calcola grafico, picco, media, ore di ascolto, per ora e per programma', () => {
    const p = period('giorno', '2026-11-16')
    const samples = []
    // 10:00-10:59 → 10 ascoltatori + 2 sul secondario; 21:00-21:29 → 30
    for (let m = 0; m < 60; m++) samples.push({ t: at('2026-11-16T10:00') + m * 60_000, a: 10, b: 2 })
    for (let m = 0; m < 30; m++) samples.push({ t: at('2026-11-16T21:00') + m * 60_000, a: 30, b: null })
    const progs = [
      { id: 'mattina', title: 'Mattina', slots: [{ days: [1], start: '10:00', end: '11:00' }] },
      { id: 'sera', title: 'Sera', slots: [{ days: [1], start: '21:00', end: '23:00' }] },
      { id: 'mai', title: 'Mai', slots: [{ days: [0], start: '10:00', end: '11:00' }] }
    ]
    const r = report(samples, p.from, p.to, p.step, progs)
    expect(r.step).toBe(10)
    expect(r.series).toHaveLength(9)
    expect(r.series[0]).toEqual({ t: at('2026-11-16T10:00'), avg: 12, peak: 12, a: 10, b: 2 })
    expect(r.series.at(-1)).toMatchObject({ avg: 30, b: null })
    expect(r.peak).toBe(30)
    expect(r.peakAt).toBe(at('2026-11-16T21:00'))
    expect(r.avg).toBe(18) // (60×12 + 30×30) / 90
    expect(r.hours).toBe(27) // 720 + 900 ascoltatori-minuto
    expect(r.byHour[10]).toEqual({ hour: 10, avg: 12, peak: 12 })
    expect(r.byHour[3]).toEqual({ hour: 3, avg: 0, peak: 0 })
    expect(r.byProgram).toEqual([
      { id: 'mattina', title: 'Mattina', avg: 12, peak: 12, hours: 12, minutes: 60 },
      { id: 'sera', title: 'Sera', avg: 30, peak: 30, hours: 15, minutes: 30 }
    ].sort((a, b) => b.hours - a.hours))
    expect(report([], p.from, p.to, p.step, progs)).toMatchObject({ peak: 0, peakAt: null, avg: 0, hours: 0, series: [] })
  })

  it('settimana da lunedì, punti ogni ora', () => {
    const w = period('settimana', '2026-11-19') // giovedì
    expect(new Date(w.from).getDay()).toBe(1)
    expect(new Date(w.from).getDate()).toBe(16)
    expect((w.to - w.from) / 3600_000).toBe(24 * 7)
    expect(w.step).toBe(60)
  })

  it('legge gli Icecast: pagina pubblica o statistiche di amministrazione', async () => {
    expect(fromStatusJson({ icestats: { source: [{ listenurl: 'http://x:8000/radio.mp3', listeners: 4 }] } }, '/radio.mp3')).toBe(4)
    expect(fromStatusJson({ icestats: {} }, '/radio.mp3')).toBeNull()
    const xml = '<icestats><source mount="/altro.mp3"><listeners>1</listeners></source><source mount="/radio.mp3"><bitrate>128</bitrate><listeners>7</listeners></source></icestats>'
    expect(fromAdminXml(xml, '/radio.mp3')).toBe(7)
    expect(fromAdminXml(xml, '/manca.mp3')).toBeNull()

    const calls: string[] = []
    const fake = (closed: boolean) => async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(`${url} ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? ''}`)
      if (url.endsWith('/admin/stats')) return new Response(xml)
      if (closed) return new Response('vietato', { status: 403 })
      return Response.json({ icestats: { source: { listenurl: 'http://x/radio.mp3', listeners: 3 } } })
    }
    expect(await readSecondary({ host: '', port: 8000, mount: '/radio.mp3' }, fake(false))).toBeNull()
    expect(await readSecondary({ host: 'sec.test', port: 8000, mount: '/radio.mp3' }, fake(false))).toBe(3)
    expect(await readSecondary({ host: 'sec.test', port: 8000, mount: '/radio.mp3' }, fake(true))).toBeNull()
    calls.length = 0
    expect(await readSecondary({ host: 'sec.test', port: 8000, mount: '/radio.mp3', adminUser: 'admin', adminPassword: 'pw' }, fake(true))).toBe(7)
    expect(calls[0]).toBe(`http://sec.test:8000/admin/stats Basic ${Buffer.from('admin:pw').toString('base64')}`)
  })
})
