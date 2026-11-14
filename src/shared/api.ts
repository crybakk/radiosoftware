import type { TrackEdit, TrackSearch } from '../core/db'
import type { EngineStep } from '../core/playout'
import type { ScanProgress } from '../core/scanner'
import type { LibraryFolder, LogEntry, ScheduledEvent, Settings, Track, TrackKind } from '../core/types'

export interface LibraryStatus {
  total: number
  byKind: Record<string, number>
  pendingAnalysis: number
  scanning: ScanProgress | null
  analyzing: boolean
}

/** Funzioni che il processo principale offre all'interfaccia (window.radio). */
export interface RadioApi {
  // libreria
  listFolders(): Promise<LibraryFolder[]>
  chooseAndAddFolder(kind: TrackKind): Promise<LibraryFolder[]>
  removeFolder(id: number): Promise<LibraryFolder[]>
  scan(): Promise<void>
  libraryStatus(): Promise<LibraryStatus>
  search(q: TrackSearch): Promise<{ tracks: Track[]; total: number }>
  getTrack(id: number): Promise<Track | null>
  getTracks(ids: number[]): Promise<Track[]>
  updateTrack(id: number, edit: TrackEdit): Promise<Track | null>
  mediaUrl(track: Pick<Track, 'id' | 'path'>): string
  listGenres(): Promise<string[]>

  // impostazioni
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>

  // eventi a orario
  listEvents(): Promise<ScheduledEvent[]>
  saveEvent(e: Omit<ScheduledEvent, 'id'> & { id?: number }): Promise<ScheduledEvent[]>
  deleteEvent(id: number): Promise<ScheduledEvent[]>

  // rotazione e registro (usati dal motore di messa in onda)
  fillQueue(upcoming: { trackId: number; at: string }[], count: number): Promise<Track[]>
  logStart(track: Track, at: string): Promise<number>
  /** Esegue le azioni di un evento e restituisce i passi per il motore. */
  expandEvent(event: ScheduledEvent): Promise<EngineStep[]>
  /** Sceglie un file di playlist o una cartella. */
  choosePath(kind: 'playlist' | 'folder'): Promise<string | null>
  logEnd(logId: number, at: string, playedSeconds: number): Promise<void>
  listLog(from: string, to: string): Promise<LogEntry[]>
  exportLogCsv(from: string, to: string): Promise<string | null>

  onLibraryStatus(cb: (s: LibraryStatus) => void): () => void
}

declare global {
  interface Window {
    radio: RadioApi
  }
}
