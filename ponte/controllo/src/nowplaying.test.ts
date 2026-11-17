import { describe, expect, it } from 'vitest'
import { apiNowPlaying, icecastListeners, NowPlaying, type NowPlayingInfo } from './nowplaying.ts'

const T = Date.parse('2026-11-15T20:00:00Z')
const info = (over: Partial<NowPlayingInfo> = {}): NowPlayingInfo => ({
  base: 'https://radio.test',
  station: 'radio_test',
  name: 'Radio Test',
  description: '',
  listenUrl: 'https://radio.test/radio.mp3',
  mount: '/radio.mp3',
  bitrate: 128,
  listeners: 12,
  online: true,
  live: { isLive: false, streamer: '', since: null },
  art: 'https://radio.test/api/logo',
  now: T + 65_000,
  ...over
})

describe('titolo in onda come AzuraCast', () => {
  it('tiene brano in onda e storico, ignora i brani vecchi', () => {
    const np = new NowPlaying()
    np.set({ artist: 'A', title: 'Uno', duration: 200, at: T - 300_000, source: 'regia' })
    np.set({ artist: 'B', title: 'Due', duration: 180, at: T, source: 'autonoma' })
    // etichetta messa dopo per un passaggio di ieri: non cambia il titolo in onda
    np.set({ artist: 'C', title: 'Vecchio', duration: 100, at: T - 86_400_000, source: 'esterna' })
    // lo stesso brano rimandato subito (metadati e registro): una volta sola
    np.set({ artist: 'B', title: 'Due', duration: 180, at: T + 1000, source: 'regia' })
    expect(np.current()?.title).toBe('Due')
    expect(np.history().map((s) => s.title)).toEqual(['Uno'])
    for (let i = 0; i < 10; i++) np.set({ artist: 'X', title: `t${i}`, duration: 0, at: T + 60_000 * (i + 1), source: 'riserva' })
    expect(np.history()).toHaveLength(5)
  })

  it('risponde con i campi di Api_NowPlaying', () => {
    const np = new NowPlaying()
    np.set({ artist: 'A', title: 'Uno', duration: 200, at: T - 300_000, source: 'regia' })
    np.set({ artist: 'B', title: 'Due', duration: 180, at: T, source: 'regia' })
    const r = apiNowPlaying(np, info({ live: { isLive: true, streamer: 'Buongiorno Città', since: T } })) as Record<string, any>
    expect(Object.keys(r).sort()).toEqual(['cache', 'is_online', 'listeners', 'live', 'now_playing', 'playing_next', 'song_history', 'station'].sort())
    expect(r.station).toMatchObject({ id: 1, shortcode: 'radio_test', listen_url: 'https://radio.test/radio.mp3', mounts: [{ path: '/radio.mp3', is_default: true, listeners: { current: 12 } }] })
    expect(r.listeners).toEqual({ total: 12, unique: 12, current: 12 })
    expect(r.live).toEqual({ is_live: true, streamer_name: 'Buongiorno Città', broadcast_start: T / 1000, art: null })
    expect(r.now_playing).toMatchObject({ played_at: T / 1000, duration: 180, elapsed: 65, remaining: 115, song: { text: 'B - Due', artist: 'B', title: 'Due', art: 'https://radio.test/api/logo' } })
    expect(r.now_playing.song.id).toMatch(/^[0-9a-f]{32}$/)
    expect(r.song_history[0].song.title).toBe('Uno')
    expect(r.playing_next).toBeNull()
    const empty = apiNowPlaying(new NowPlaying(), info()) as Record<string, unknown>
    expect(empty.now_playing).toBeNull()
  })

  it('legge gli ascoltatori dal JSON di Icecast', () => {
    const one = { icestats: { source: { listenurl: 'http://radio.test:8000/radio.mp3', listeners: 7 } } }
    const many = { icestats: { source: [{ listenurl: 'http://x:8000/altro.mp3', listeners: 3 }, { listenurl: 'http://x:8000/radio.mp3', listeners: 9 }] } }
    expect(icecastListeners(one, '/radio.mp3')).toEqual({ listeners: 7, online: true })
    expect(icecastListeners(many, '/radio.mp3')).toEqual({ listeners: 9, online: true })
    expect(icecastListeners({ icestats: {} }, '/radio.mp3')).toEqual({ listeners: 0, online: false })
    // un mount con indirizzo malformato (o una voce nulla) non fa fallire /api/nowplaying
    const bad = { icestats: { source: [null, { listenurl: 'http://[x', listeners: 3 }, { listenurl: 'http://h/radio.mp3', listeners: 4 }] } }
    expect(icecastListeners(bad, '/radio.mp3')).toEqual({ listeners: 4, online: true })
  })

  it('HLS acceso: indirizzo come AzuraCast e ascoltatori nel totale', () => {
    const r = apiNowPlaying(new NowPlaying(), info({ hls: { url: 'https://radio.test/hls/radio_test/live.m3u8', listeners: 5 } })) as Record<string, any>
    expect(r.station.hls_enabled).toBe(true)
    expect(r.station.hls_is_default).toBe(true)
    expect(r.station.hls_url).toBe('https://radio.test/hls/radio_test/live.m3u8')
    expect(r.station.hls_listeners).toBe(5)
    expect(r.listeners.total).toBe(17)
    expect(r.station.mounts[0].listeners.total).toBe(12)
    // l'MP3 resta l'indirizzo d'ascolto per chi non usa l'HLS
    expect(r.station.listen_url).toBe('https://radio.test/radio.mp3')
    const off = apiNowPlaying(new NowPlaying(), info()) as Record<string, any>
    expect(off.station.hls_enabled).toBe(false)
    expect(off.station.hls_url).toBeNull()
    expect(off.listeners.total).toBe(12)
  })
})
