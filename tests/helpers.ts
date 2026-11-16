import type { AudioBackend, Player } from '../src/core/playout'
import type { Track } from '../src/core/types'

let nextId = 1
export function makeTrack(p: Partial<Track> = {}): Track {
  const id = p.id ?? nextId++
  return {
    id,
    path: `/music/${id}.mp3`,
    kind: 'music',
    title: `Titolo ${id}`,
    artist: `Artista ${id}`,
    album: '',
    year: null,
    genre: '',
    composer: '',
    publisher: '',
    isrc: '',
    iswc: '',
    mbGenres: '',
    siaeCode: '',
    duration: 180,
    bitrate: 192,
    sampleRate: 44100,
    loudness: -14,
    cueIn: 0,
    cueOut: 180,
    mixPoint: 175,
    enabled: true,
    analyzedAt: null,
    addedAt: '2026-01-01',
    ...p
  }
}

export class FakeClock {
  t: number
  constructor(start = new Date(2026, 10, 16, 9, 0, 0)) {
    this.t = start.getTime()
  }
  now = (): Date => new Date(this.t)
  advance(seconds: number): void {
    this.t += seconds * 1000
  }
}

export class FakePlayer implements Player {
  startedAt: number | null = null
  fadingFor: number | null = null
  stopped = false
  private ended: (() => void)[] = []
  constructor(
    public track: Track,
    public gainDb: number,
    private clock: FakeClock,
    private fail = false
  ) {}
  async start(): Promise<void> {
    if (this.fail) throw new Error('file mancante')
    this.startedAt = this.clock.t
  }
  position(): number {
    if (this.startedAt == null) return 0
    return this.track.cueIn + (this.clock.t - this.startedAt) / 1000
  }
  fadeOut(seconds: number): void {
    this.fadingFor = seconds
  }
  stop(): void {
    this.stopped = true
  }
  onEnded(cb: () => void): void {
    this.ended.push(cb)
  }
  end(): void {
    for (const cb of this.ended) cb()
  }
}

export class FakeBackend implements AudioBackend {
  players: FakePlayer[] = []
  failPaths = new Set<string>()
  constructor(private clock: FakeClock) {}
  createPlayer(track: Track, gainDb: number): FakePlayer {
    const p = new FakePlayer(track, gainDb, this.clock, this.failPaths.has(track.path))
    this.players.push(p)
    return p
  }
  /** Simula la fine naturale dei brani arrivati alla fine o sfumati. */
  settle(): void {
    for (const p of this.players) {
      if (p.startedAt == null || p.stopped) continue
      if (p.fadingFor != null || p.position() >= p.track.cueOut) {
        p.stopped = true
        p.end()
      }
    }
  }
}
