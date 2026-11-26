import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
    // la voce non si produce allo scatto ma quando l'annuncio sta per andare in onda
    expect(spoken).toEqual([])
    expect(s.waiting()).toBe(1)
    now = new Date(2026, 10, 15, 23, 3, 20)
    // finisce il brano in corso alle 23:03:40: l'ora detta è quella in cui va in onda
    expect(await s.take(new Date(2026, 10, 15, 23, 3, 40))).toMatchObject({ id: '.annunci/annuncio-1.mp3', seconds: 4 })
    expect(spoken).toEqual(['Sono le 23 e 3. Qui Radio Prova. Avete ascoltato Caruso.'])
    expect(await s.take()).toBeNull()

    // un annuncio non andato in onda entro 10 minuti si butta
    now = new Date(2026, 10, 16, 0, 0, 1)
    await s.tick()
    now = new Date(2026, 10, 16, 0, 11, 0)
    expect(await s.take()).toBeNull()
    expect(spoken).toHaveLength(1)
  })

  it('voce troppo lenta: l\'annuncio resta in attesa e al brano dopo dice l\'ora nuova', async () => {
    const store = new AnnounceStore(join(mkdtempSync(join(tmpdir(), 'ann-')), 'annunci.json'))
    await store.save({ radio: '', items: [item({ text: 'Sono le {ora}.' })] })
    let now = new Date(2026, 10, 15, 23, 0, 1)
    let slow = true
    const spoken: string[] = []
    const s = new AnnounceScheduler({
      store,
      speak: (text) =>
        slow
          ? new Promise(() => {})
          : (spoken.push(text), Promise.resolve({ file: `/m/.annunci/a-${spoken.length}.mp3`, seconds: 3 })),
      onAir: async () => true,
      context: () => ({}),
      stationName: 'R',
      folder: '.annunci',
      now: () => now,
      log: () => {},
      speakTimeoutMs: 20
    })
    await s.tick()
    expect(await s.take(new Date(2026, 10, 15, 23, 2, 0))).toBeNull()
    expect(s.waiting()).toBe(1)
    slow = false
    now = new Date(2026, 10, 15, 23, 5, 30)
    expect(await s.take(new Date(2026, 10, 15, 23, 5, 50))).toMatchObject({ title: 'Sono le 23 e 5.' })
    expect(s.waiting()).toBe(0)
  })
})

describe('annunci a orario: anticipo per l\'HLS', () => {
  it('parte 30 secondi prima e dice l\'ora prevista', async () => {
    const store = new AnnounceStore(join(mkdtempSync(join(tmpdir(), 'ann-')), 'annunci.json'))
    await store.save({ radio: '', items: [item({ text: 'Sono le {ora}.' })] })
    let now = new Date(2026, 10, 15, 22, 59, 25)
    const spoken: string[] = []
    const s = new AnnounceScheduler({
      store,
      speak: async (text) => {
        spoken.push(text)
        return { file: `/musica/.annunci/a-${spoken.length}.mp3`, seconds: 2 }
      },
      onAir: async () => true,
      context: () => ({}),
      stationName: 'Radio Prova',
      folder: '.annunci',
      now: () => now,
      log: () => {},
      anticipoSecondi: 30
    })
    await s.tick()
    expect(s.waiting()).toBe(0) // 22:59:55 per chi ascolta: ancora presto
    now = new Date(2026, 10, 15, 22, 59, 31)
    await s.tick()
    expect(s.waiting()).toBe(1)
    await s.take(now)
    expect(spoken).toEqual(['Sono le 23 in punto.'])
    now = new Date(2026, 10, 15, 23, 0, 5)
    await s.tick()
    expect(s.waiting()).toBe(0) // non si ripete all'ora vera
    // se va in onda dopo un brano, l'ora è quella in cui lo sente chi ascolta in HLS (30 secondi dopo)
    now = new Date(2026, 10, 16, 22, 59, 31)
    await s.tick()
    await s.take(new Date(2026, 10, 16, 23, 2, 40))
    expect(spoken[1]).toBe('Sono le 23 e 3.')
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
      const tickAndAir = async (): Promise<void> => {
        await s.tick()
        while (await s.take()) {
          // va in onda subito
        }
      }
      await tickAndAir()
      expect(now.getHours()).toBe(2)
      now = new Date('2026-10-25T00:31:10Z') // il minuto dopo
      await tickAndAir()
      now = new Date('2026-10-25T01:30:10Z') // di nuovo 02:30, ora solare
      expect(now.getHours()).toBe(2)
      await tickAndAir()
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
    p.interject = async () => {
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
    expect(await p.nextReserve()).toBe('/musica/.annunci/annuncio-y.mp3')
    expect(await p.nextReserve()).toBe('annotate:title="Uno",artist="A":/musica/a/uno.mp3')
    await p.run({ type: 'stop' })
  })

  it('dice all\'annuncio quando andrà in onda: alla fine del brano in corso', async () => {
    let now = 1_000_000
    const p = new AutonomousPlayer(lib, { setActive: async () => true, push: async () => true, skip: async () => true }, () => now)
    const asked: number[] = []
    p.interject = async (at) => (asked.push(at.getTime()), null)
    // riserva ferma: il primo brano parte subito
    await p.nextReserve()
    expect(asked.at(-1)).toBe(now)
    // Liquidsoap chiede il successivo appena parte il primo (prima o dopo averlo detto)
    await p.nextReserve()
    expect(asked.at(-1)).toBe(now + 200_000)
    p.onReserveStart('/musica/a/uno.mp3')
    now += 200_000
    p.onReserveStart('/musica/a/uno.mp3')
    await p.nextReserve()
    expect(asked.at(-1)).toBe(now + 200_000)
    // torna la regia: la riserva non suona più, alla ripartenza c'è ancora il brano tenuto pronto
    p.reserveStopped()
    now += 3600_000
    await p.nextReserve()
    expect(asked.at(-1)).toBe(now + 200_000)

    // diretta autonoma: all'avvio subito, poi alla fine del brano in onda
    asked.length = 0
    await p.run({ type: 'start' })
    expect(asked).toEqual([now])
    vi.useFakeTimers()
    try {
      p.onTrackStart('/musica/a/uno.mp3')
      await vi.advanceTimersByTimeAsync(180_000)
      expect(asked).toEqual([now, now + 200_000])
    } finally {
      vi.useRealTimers()
    }
    await p.run({ type: 'stop' })
  })
})
