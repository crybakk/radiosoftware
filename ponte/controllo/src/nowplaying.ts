/**
 * Titolo in onda nel formato di AzuraCast (/api/nowplaying), per l'app della radio dopo la migrazione.
 *
 * Il titolo arriva da chi è in onda: regia (metadati), diretta autonoma, musica di riserva, brani riconosciuti
 * nelle dirette esterne. Gli ascoltatori si leggono dall'Icecast principale (status-json.xsl).
 */
import { createHash } from 'node:crypto'

export interface Song {
  artist: string
  title: string
  /** Secondi (0 se non si sa). */
  duration: number
  /** Inizio, in ms. */
  at: number
  /** Da dove arriva: regia, autonoma, riserva, esterna. */
  source: string
}

export interface Listeners {
  total: number
  unique: number
  current: number
}

const HISTORY = 5

/** Brano in onda e ultimi brani passati. */
export class NowPlaying {
  private cur: Song | null = null
  private past: Song[] = []

  /** Nuovo brano in onda; ignorato se è più vecchio di quello attuale (es. etichette messe dopo). */
  set(s: Song): void {
    if (!s.title.trim() && !s.artist.trim()) return
    if (this.cur && s.at < this.cur.at) return
    if (this.cur && this.cur.artist === s.artist && this.cur.title === s.title && s.at - this.cur.at < 30_000) return
    if (this.cur) this.past = [this.cur, ...this.past].slice(0, HISTORY)
    this.cur = { ...s, artist: s.artist.trim(), title: s.title.trim() }
  }

  current(): Song | null {
    return this.cur
  }

  history(): Song[] {
    return [...this.past]
  }
}

/** Ascoltatori di un mount dal JSON di Icecast (status-json.xsl). */
export function icecastListeners(status: unknown, mount: string): { listeners: number; online: boolean } {
  const src = (status as { icestats?: { source?: unknown } })?.icestats?.source
  const list = (Array.isArray(src) ? src : src ? [src] : []) as { listenurl?: string; listeners?: number }[]
  const m = list.find((x) => typeof x.listenurl === 'string' && new URL(x.listenurl, 'http://x').pathname === mount)
  return { listeners: Number(m?.listeners) || 0, online: !!m }
}

export interface NowPlayingInfo {
  base: string
  station: string
  name: string
  description: string
  listenUrl: string
  mount: string
  bitrate: number
  listeners: number
  online: boolean
  /** Diretta esterna o programma in onda. */
  live: { isLive: boolean; streamer: string; since: number | null }
  /** Immagine per i brani (copertina del programma in corso o logo); '' se non c'è. */
  art: string
  now: number
}

const songId = (s: Song): string => createHash('md5').update(`${s.artist} - ${s.title}`.toLowerCase()).digest('hex')
const sec = (ms: number): number => Math.floor(ms / 1000)

function apiSong(s: Song, art: string): Record<string, unknown> {
  return {
    id: songId(s),
    art,
    custom_fields: [],
    text: s.artist ? `${s.artist} - ${s.title}` : s.title,
    artist: s.artist,
    title: s.title,
    album: '',
    genre: '',
    isrc: '',
    lyrics: ''
  }
}

function history(s: Song, n: number, info: NowPlayingInfo): Record<string, unknown> {
  return {
    sh_id: sec(s.at) * 10 + n,
    played_at: sec(s.at),
    duration: Math.round(s.duration),
    playlist: s.source,
    streamer: '',
    is_request: false,
    song: apiSong(s, info.art)
  }
}

/** Api_NowPlaying di AzuraCast. */
export function apiNowPlaying(np: NowPlaying, info: NowPlayingInfo): Record<string, unknown> {
  const l: Listeners = { total: info.listeners, unique: info.listeners, current: info.listeners }
  const cur = np.current()
  let nowPlaying: Record<string, unknown> | null = null
  if (cur) {
    const elapsed = Math.max(0, sec(info.now - cur.at))
    const duration = Math.round(cur.duration)
    nowPlaying = { ...history(cur, 0, info), elapsed: duration ? Math.min(elapsed, duration) : elapsed, remaining: duration ? Math.max(0, duration - elapsed) : 0 }
  }
  const root = `${info.base}/api/station/${info.station}`
  return {
    station: {
      id: 1,
      name: info.name,
      shortcode: info.station,
      description: info.description,
      frontend: 'icecast',
      backend: 'liquidsoap',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      listen_url: info.listenUrl,
      url: info.base,
      public_player_url: `${info.base}/ascolta.html`,
      playlist_pls_url: `${root}/playlist.pls`,
      playlist_m3u_url: `${root}/playlist.m3u`,
      is_public: true,
      requests_enabled: false,
      mounts: [
        { id: 1, name: `${info.mount} (${info.bitrate}kbps MP3)`, url: info.listenUrl, bitrate: info.bitrate, format: 'mp3', listeners: l, path: info.mount, is_default: true }
      ],
      remotes: [],
      hls_enabled: false,
      hls_is_default: false,
      hls_url: null,
      hls_listeners: 0
    },
    listeners: l,
    live: { is_live: info.live.isLive, streamer_name: info.live.streamer, broadcast_start: info.live.since === null ? null : sec(info.live.since), art: null },
    now_playing: nowPlaying,
    playing_next: null,
    song_history: np.history().map((s, i) => history(s, i + 1, info)),
    is_online: info.online,
    cache: null
  }
}
