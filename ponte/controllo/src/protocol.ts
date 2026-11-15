/**
 * Messaggi tra regia, ponte e pannello remoto (JSON su WebSocket).
 * Questo file è usato sia dal ponte sia dalla regia: solo tipi, nessun codice.
 */

export type RemoteKind = 'music' | 'jingle' | 'spot' | 'news' | 'program'

export interface RemoteTrack {
  id: number
  title: string
  artist: string
  kind: RemoteKind
  duration: number
}

export interface RemoteState {
  mode: 'auto' | 'manual'
  onAir: (RemoteTrack & { position: number; remaining: number; eventLabel?: string }) | null
  queue: (RemoteTrack & { uid: string; eta: string; origin: 'manual' | 'auto' | 'event'; eventLabel?: string })[]
  carts: { n: number; name: string | null; playing: boolean }[]
  uplink: string
  lastError: string | null
  /** Ora della regia (ISO), per mostrare i tempi giusti anche con orologi diversi. */
  at: string
}

export type RemoteCommand =
  | { type: 'play' }
  | { type: 'next' }
  | { type: 'stop' }
  | { type: 'mode'; mode: 'auto' | 'manual' }
  | { type: 'cart'; n: number }
  | { type: 'stopCarts' }
  | { type: 'enqueue'; trackId: number; where: 'next' | 'end' }
  | { type: 'remove'; uid: string }
  | { type: 'move'; uid: string; delta: -1 | 1 }
  | { type: 'search'; q: string }
  /** Replica: una puntata pubblicata del programma (la più recente se manca episodeId). */
  | { type: 'replay'; programId: string; episodeId?: string; where: 'next' | 'end' }

/** Diretta autonoma dal server (senza regia). */
export interface AutoTrack {
  id: string
  title: string
  artist: string
  duration: number
}

export interface AutoState {
  active: boolean
  onAir: (AutoTrack & { startedAt: string }) | null
  /** Già passato al mixer: partirà dopo quello in onda. */
  prepared: AutoTrack | null
  queue: (AutoTrack & { uid: string })[]
  libraryCount: number
}

export type AutoCommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'skip' }
  | { type: 'enqueue'; id: string; where: 'next' | 'end' }
  | { type: 'remove'; uid: string }
  | { type: 'search'; q: string }

/** Ospiti collegati con un link. */
export interface GuestInvite {
  token: string
  /** Nome scritto dal conduttore (es. "Mario, intervista delle 18"). */
  label: string
  by: string
  createdAt: string
  expiresAt: string
}

export interface GuestInfo {
  id: string
  name: string
  label: string
  state: 'attesa' | 'dentro'
  onAir: boolean
  /** Audio collegato (WebRTC). */
  connected: boolean
  since: string
}

export type GuestCommand =
  | { type: 'invite'; label: string }
  | { type: 'invites' }
  | { type: 'revoke'; token: string }
  | { type: 'admit'; id: string }
  | { type: 'reject'; id: string }
  | { type: 'kick'; id: string }
  | { type: 'air'; id: string; on: boolean }

/** Dirette video verso YouTube e Facebook. */
export type VideoSource = 'logo' | 'obs'
export type VideoDestination = 'youtube' | 'facebook'

export interface VideoStatus {
  state: 'spenta' | 'avvio' | 'attesa_obs' | 'in_onda' | 'errore'
  source: VideoSource | null
  destinations: VideoDestination[]
  since: string | null
  by: string | null
  error: string | null
  detail: string
  /** Chiavi impostate (le chiavi non escono mai dal ponte). */
  youtube: boolean
  facebook: boolean
  hasLogo: boolean
  delayMs: number
  /** Porta UDP su cui OBS manda il video (SRT). */
  obsPort: number
  obsPassphrase: boolean
}

export type VideoCommand =
  | { type: 'start'; source: VideoSource; destinations: VideoDestination[] }
  | { type: 'stop' }
  | { type: 'config'; youtubeKey?: string; facebookUrl?: string; facebookKey?: string; delayMs?: number }

/** Regia → ponte */
export type FromStudio =
  | { t: 'auth'; token: string }
  | { t: 'state'; state: RemoteState }
  | { t: 'reply'; id: string; ok: boolean; data?: unknown; error?: string }

/** Ponte → regia */
export type ToStudio = { t: 'auth-ok' } | { t: 'cmd'; id: string; cmd: RemoteCommand; by: string }

/** Pannello → ponte */
export type FromPanel =
  | { t: 'cmd'; id: string; cmd: RemoteCommand }
  /** Microfono: offerta WebRTC del browser. */
  | { t: 'rtc-offer'; id: string; sdp: string }
  /** Microfono in onda o fuori onda. */
  | { t: 'mic'; id: string; on: boolean }
  /** Chiude il microfono. */
  | { t: 'rtc-close' }
  /** Diretta autonoma. */
  | { t: 'auto'; id: string; cmd: AutoCommand }
  /** Ospiti. */
  | { t: 'guest'; id: string; cmd: GuestCommand }
  /** Dirette video. */
  | { t: 'video'; id: string; cmd: VideoCommand }

export interface MicStatus {
  /** Chi ha il microfono aperto (null = nessuno). */
  user: string | null
  onAir: boolean
}

/** Ponte → pannello */
export type ToPanel =
  | { t: 'hello'; user: { name: string; role: string }; studio: boolean; state: RemoteState | null }
  | { t: 'state'; state: RemoteState }
  | { t: 'studio'; connected: boolean }
  | { t: 'reply'; id: string; ok: boolean; data?: unknown; error?: string }
  | { t: 'alarms'; alarms: { key: string; since: string; message: string }[] }
  | { t: 'mic'; mic: MicStatus }
  | { t: 'autonoma'; state: AutoState }
  | { t: 'ospiti'; guests: GuestInfo[] }
  | { t: 'video'; video: VideoStatus }
