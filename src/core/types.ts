/** Tipo di elemento audio: decide come viene usato in rotazione e nella cartwall. */
export type TrackKind = 'music' | 'jingle' | 'spot' | 'news' | 'program'

export const TRACK_KINDS: { value: TrackKind; label: string }[] = [
  { value: 'music', label: 'Musica' },
  { value: 'jingle', label: 'Jingle' },
  { value: 'news', label: 'Notiziari' },
  { value: 'program', label: 'Programmi registrati' },
  { value: 'spot', label: 'Spot / promo' }
]

export interface Track {
  id: number
  path: string
  kind: TrackKind
  title: string
  artist: string
  album: string
  year: number | null
  genre: string
  composer: string
  publisher: string
  isrc: string
  iswc: string
  siaeCode: string
  /** Durata in secondi. */
  duration: number
  /** Bitrate in kbps (0 se sconosciuto). */
  bitrate: number
  sampleRate: number
  /** Loudness integrata EBU R128 (LUFS). null se non ancora analizzato. */
  loudness: number | null
  /** Secondi: dove inizia l'audio utile. */
  cueIn: number
  /** Secondi: dove finisce l'audio utile. */
  cueOut: number
  /** Secondi: dove può partire il brano successivo (dissolvenza). */
  mixPoint: number
  enabled: boolean
  analyzedAt: string | null
  addedAt: string
}

export interface LibraryFolder {
  id: number
  path: string
  kind: TrackKind
}

export interface Settings {
  /** Loudness obiettivo per il livellamento (LUFS). */
  targetLoudness: number
  /** Durata della dissolvenza manuale e di sicurezza (secondi). */
  crossfadeSeconds: number
  /** Minuti minimi prima di ripetere lo stesso artista. */
  artistSeparationMinutes: number
  /** Minuti minimi prima di ripetere lo stesso brano. */
  titleSeparationMinutes: number
  /** Un jingle ogni N brani in automatico (0 = mai). */
  jingleEvery: number
  /** Quanti brani tenere in coda in modalità automatica. */
  autoQueueLength: number
  /** Id del dispositivo audio di uscita in onda ('' = predefinito). */
  outputDeviceId: string
  /** Id del dispositivo audio per il preascolto ('' = predefinito). */
  previewDeviceId: string
  /** Tracce assegnate ai 12 tasti della cartwall (null = vuoto). */
  cartwall: (number | null)[]
}

export const DEFAULT_SETTINGS: Settings = {
  targetLoudness: -16,
  crossfadeSeconds: 3,
  artistSeparationMinutes: 60,
  titleSeparationMinutes: 180,
  jingleEvery: 4,
  autoQueueLength: 5,
  outputDeviceId: '',
  previewDeviceId: '',
  cartwall: Array(12).fill(null)
}

/** Evento a orario fisso. */
export interface ScheduledEvent {
  id: number
  /** Orario "HH:MM". */
  time: string
  /** Giorni attivi, 0 = domenica ... 6 = sabato. */
  days: number[]
  trackId: number
  /**
   * 'soft': parte appena finisce il brano in onda (al massimo con tolleranza).
   * 'hard': parte all'orario esatto sfumando il brano in onda.
   */
  mode: 'soft' | 'hard'
  enabled: boolean
  label: string
}

export interface LogEntry {
  id: number
  trackId: number | null
  startedAt: string
  endedAt: string | null
  playedSeconds: number
  source: string
  title: string
  artist: string
  composer: string
  publisher: string
  isrc: string
  iswc: string
  siaeCode: string
  kind: TrackKind
}

/** Brano in coda (lo stesso brano può comparire più volte, uid lo distingue). */
export interface QueueItem {
  uid: string
  track: Track
  /** Da dove arriva: scelto a mano, rotazione automatica, evento. */
  origin: 'manual' | 'auto' | 'event'
}

export function gainForTrack(track: Pick<Track, 'loudness'>, targetLoudness: number): number {
  if (track.loudness == null || !Number.isFinite(track.loudness)) return 0
  const gain = targetLoudness - track.loudness
  // Limiti: non alzare troppo i brani bassi (rumore) né abbassare oltre misura.
  return Math.max(-12, Math.min(6, gain))
}
