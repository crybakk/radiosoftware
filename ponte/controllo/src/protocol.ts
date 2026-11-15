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

/** Regia → ponte */
export type FromStudio =
  | { t: 'auth'; token: string }
  | { t: 'state'; state: RemoteState }
  | { t: 'reply'; id: string; ok: boolean; data?: unknown; error?: string }

/** Ponte → regia */
export type ToStudio = { t: 'auth-ok' } | { t: 'cmd'; id: string; cmd: RemoteCommand; by: string }

/** Pannello → ponte */
export type FromPanel = { t: 'cmd'; id: string; cmd: RemoteCommand }

/** Ponte → pannello */
export type ToPanel =
  | { t: 'hello'; user: { name: string; role: string }; studio: boolean; state: RemoteState | null }
  | { t: 'state'; state: RemoteState }
  | { t: 'studio'; connected: boolean }
  | { t: 'reply'; id: string; ok: boolean; data?: unknown; error?: string }
  | { t: 'alarms'; alarms: { key: string; since: string; message: string }[] }
