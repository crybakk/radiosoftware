import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AnnounceScheduler, AnnounceStore, dueAt, validateConfig, type ScheduledAnnounce } from './annunciRadio.ts'
import { AutonomousPlayer } from './autonoma.ts'
import type { Library, ServerTrack } from './libreria.ts'

const item = (over: Partial<ScheduledAnnounce> = {}): ScheduledAnnounce => ({ id: 'a', text: 'Sono le {ora}.', time: '*:00', days: [0, 1, 2, 3, 4, 5, 6], enabled: true, ...over })

describe('annunci a orario del server', () => {
  it('controlla gli annunci', () => {
    expect(() => validateConfig({ items: [item({ text: ' ' })] })).toThrow(/testo/)
    expect(() => validateConfig({ items: [item({ time: '25:00' })] })).toThrow(/orario/)
    expect(() => validateConfig({ items: [item({ days: [9] })] })).toThrow(/giorno/)
    const c = validateConfig({ items: [item({ id: '', days: [3, 1, 1] })], voice: { speed: 5 } as never })
    expect(c.items[0].days).toEqual([1, 3])
    expect(c.items[0].id).not.toBe('')
    expect(c.voice.speed).toBe(2)
  })

  it('sceglie gli annunci del minuto', () => {
    const sun2200 = new Date(2026, 10, 15, 22, 0)
    const items = [item({ id: 'ogni-ora' }), item({ id: 'alle', time: '22:00' }), item({ id: 'lun', time: '22:00', days: [1] }), item({ id: 'spento', enabled: false }), item({ id: 'mezza', time: '*:30' })]
    expect(dueAt(items, sun2200).map((a) => a.id)).toEqual(['ogni-ora', 'alle'])
    expect(dueAt(items, new Date(2026, 10, 15, 13, 30)).map((a) => a.id)).toEqual(['mezza'])
  })

  it('prepara l\'annuncio solo quando trasmette il server, una volta al minuto', async () => {
    const store = new AnnounceStore(join(mkdtempSync(join(tmpdir(), 'ann-')), 'annunci.json'))
    await store.save({ radio: '', items: [item({ text: 'Sono le {ora}. Qui {radio}. Avete ascoltato {brano}.' })] })
    let now = new Date(2026, 10, 15, 22, 0, 5)
    let onAir = false
    const spoken: string[] = []
    const s = new AnnounceScheduler({
      store,
      speak: async (text) => {
        spoken.push(text)
        return { file: `/musica/.annunci/annuncio-${spoken.length}.mp3`, seconds: 4 }
      },
      onAir: async () => onAir,
      context: () => ({ track: { title: 'Caruso', artist: 'Lucio Dalla' } }),
      stationName: 'Radio Prova',
      folder: '.annunci',
      now: () => now,
      log: () => {}
    })
    await s.tick()
    expect(spoken).toEqual([]) // c'è la regia: niente
    now = new Date(2026, 10, 15, 23, 0, 1)
    onAir = true
    await s.tick()
    await s.tick()
    expect(spoken).toEqual(['Sono le 23 in punto. Qui Radio Prova. Avete ascoltato Caruso.'])
    expect(s.take()).toMatchObject({ id: '.annunci/annuncio-1.mp3', seconds: 4 })
    expect(s.take()).toBeNull()

    // un annuncio non andato in onda entro 10 minuti si butta
    now = new Date(2026, 10, 16, 0, 0, 1)
    await s.tick()
    now = new Date(2026, 10, 16, 0, 11, 0)
    expect(s.take()).toBeNull()
  })
})

describe('annunci a orario: ora legale', () => {
  it('quando finisce l\'ora legale un orario fisso va una volta sola, "ogni ora" va ogni ora vera', async () => {
    const tz = process.env.TZ
    process.env.TZ = 'Europe/Rome'
    try {
      const store = new AnnounceStore(join(mkdtempSync(join(tmpdir(), 'ann-')), 'annunci.json'))
      await store.save({ radio: '', items: [item({ id: 'fisso', text: 'Fisso.', time: '02:30' }), item({ id: 'ora', text: 'Ogni ora.', time: '*:30' })] })
      let now = new Date('2026-10-25T00:30:10Z') // 02:30 ora legale
      const spoken: string[] = []
      const s = new AnnounceScheduler({
        store,
        speak: async (text) => {
          spoken.push(text)
          return { file: `/m/.annunci/annuncio-${spoken.length}.mp3`, seconds: 2 }
        },
        onAir: async () => true,
        context: () => ({}),
        stationName: 'R',
        folder: '.annunci',
        now: () => now,
        log: () => {}
      })
      await s.tick()
      expect(now.getHours()).toBe(2)
      now = new Date('2026-10-25T00:31:10Z') // il minuto dopo
      await s.tick()
      now = new Date('2026-10-25T01:30:10Z') // di nuovo 02:30, ora solare
      expect(now.getHours()).toBe(2)
      await s.tick()
      expect(spoken).toEqual(['Fisso.', 'Ogni ora.', 'Ogni ora.'])
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })
})

describe('annuncio nella diretta autonoma e nella riserva', () => {
  const tracks: ServerTrack[] = [{ id: 'a/uno.mp3', title: 'Uno', artist: 'A', duration: 200, bitrate: 320, gainDb: 0, mtime: 0, size: 0 }]
  const lib = {
    count: () => tracks.length,
    all: () => tracks,
    get: (id: string) => tracks.find((t) => t.id === id),
    path: (t: ServerTrack) => `/musica/${t.id}`,
    pickRandom: () => tracks[0],
    search: () => []
  } as unknown as Library

  it('passa l\'annuncio prima del prossimo brano e non lo mette nel registro', async () => {
    const pushed: string[] = []
    const played: string[] = []
    const p = new AutonomousPlayer(lib, { setActive: async () => true, push: async (u) => (pushed.push(u), true), skip: async () => true })
    p.onPlay = (t) => played.push(t.id)
    let next: { id: string; title: string; seconds: number } | null = { id: '.annunci/annuncio-x.mp3', title: 'Sono le 23', seconds: 4 }
    p.interject = () => {
      const n = next
      next = null
      return n
    }
    await p.run({ type: 'start' })
    expect(pushed).toEqual(['/musica/.annunci/annuncio-x.mp3'])
    expect(p.state().prepared).toMatchObject({ title: 'Sono le 23', artist: 'Annuncio vocale' })
    p.onTrackStart('/musica/.annunci/annuncio-x.mp3')
    expect(p.state().onAir?.artist).toBe('Annuncio vocale')
    expect(played).toEqual(['.annunci/annuncio-x.mp3'])
    // riserva
    next = { id: '.annunci/annuncio-y.mp3', title: 'Ciao', seconds: 2 }
    expect(p.nextReserve()).toBe('/musica/.annunci/annuncio-y.mp3')
    expect(p.nextReserve()).toBe('/musica/a/uno.mp3')
    await p.run({ type: 'stop' })
  })
})
