import type { VoiceInfo, VoiceSettings } from '../../ponte/controllo/src/annunci.ts'
import type { NewsSource } from '../core/news'
import type { TrackEdit, TrackSearch } from '../core/db'
import type { EngineStep } from '../core/playout'
import type { ScanProgress } from '../core/scanner'
import type { ListenerStats, PonteBackup, PonteProgram, PonteState } from '../core/ponteClient'
import type { RemoteCommand, RemoteState } from '../core/remote'
import type { PonteStatus, StudioReport } from '../main/ponte'
import type { ServerSyncStatus, ServerTrackRow } from '../main/serverSync'
import type { MbStatus } from '../main/musicbrainz'
import type { TagService, TagStatus } from '../main/tagServices'
import type { AiResult, AiStatus } from '../main/ai'
import type { EsitoPulizia } from '../main/pulizia'
import type { AiTitoliStatus } from '../main/aiTitoli'
import type { AiPlan } from '../core/aiRotation'
import type { SiaeRow } from '../core/siae'
import type { LibraryFolder, LogEntry, ScheduledEvent, Settings, Track, TrackKind } from '../core/types'

export interface LibraryStatus {
  total: number
  byKind: Record<string, number>
  pendingAnalysis: number
  /** Musica nascosta perché più lunga della durata massima (premixati). */
  hiddenLong: number
  /** Durata massima in minuti (0 = nessun limite), impostata dal pannello del server. */
  maxTrackMinutes: number
  scanning: ScanProgress | null
  analyzing: boolean
  /** Impronte audio calcolate sulla musica (riconoscimento nelle esterne). */
  fingerprints: number
  fingerprintTotal: number
  fingerprinting: boolean
  /** Musica ascoltata per riconoscere i live dal suono (applausi). */
  liveChecked: number
  liveTotal: number
  liveChecking: boolean
  /** Analisi "da DJ" (Mix DJ): brani fatti, totale della musica, in corso. */
  djDone: number
  djTotal: number
  djAnalyzing: boolean
}

/** Funzioni che il processo principale offre all'interfaccia (window.radio). */
export type VoiceState = VoiceInfo & { installed: boolean; downloading: boolean }
/** Brano in onda e prossimo, per {brano} e {prossimo_brano} negli annunci. */
export interface AnnounceCtx {
  track?: { title: string; artist: string } | null
  nextTrack?: { title: string; artist: string } | null
  /** Nome della radio (se diverso da quello salvato, per le prove). */
  radio?: string
}

/** Aggiornamento della regia dalle release (si installa solo premendo "Aggiorna"). */
export interface AggiornamentoStato {
  stato: 'nessuno' | 'disponibile' | 'scarico' | 'pronto' | 'errore'
  /** versione installata */
  attuale: string
  /** versione nuova */
  versione?: string
  percentuale?: number
  errore?: string
  /** esito dell'ultimo controllo: 'in corso', 'ok', 'non riuscito: …', 'non installato' */
  controllo?: string
  /** quando è stato fatto l'ultimo controllo (ISO) */
  controllato?: string
  /** cosa cambia nella regia con l'aggiornamento (dalla versione più recente) */
  novita?: NovitaVersione[]
  /** c'è questa versione più nuova, ma cambia solo il server: la regia non ha bisogno di aggiornarsi */
  soloServer?: string
}

/** Novità di una versione (dalle note della release). */
export interface NovitaVersione {
  versione: string
  novita: string[]
}

/** Novità dell'aggiornamento appena installato, da mostrare alla prima apertura. */
export interface NovitaInstallate {
  da: string
  a: string
  novita: NovitaVersione[]
}

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
  /** Categorie della musica (generi di file e servizi, etichette tue) con il numero di brani. */
  categories(): Promise<{ name: string; count: number; mine: boolean }[]>
  /** Mette (on) o toglie un'etichetta tua sui brani; restituisce quanti sono cambiati. */
  setUserTag(ids: number[], tag: string, on: boolean): Promise<number>
  /** Musica che non sembra radiofonica (Track 01, live@, titoli che non sono titoli), col motivo. */
  daControllare(): Promise<{ tracks: (Track & { motivo: string })[]; total: number }>
  /** Doppioni (stesso artista e titolo): la prima copia di ogni gruppo è quella da tenere. */
  doppioni(): Promise<{ gruppi: { tieni: number; tracks: Track[] }[]; total: number }>
  /** "Va bene così": non compaiono più tra quelli da controllare (on = false li rimette). */
  segnaRadiofonico(ids: number[], on?: boolean): Promise<number>
  /** Toglie dalla libreria senza toccare i file. */
  togliDallaLibreria(ids: number[]): Promise<EsitoPulizia>
  /** Toglie dalla libreria e sposta i file nella sottocartella "_Tolti dalla libreria". */
  spostaNegliScarti(ids: number[]): Promise<EsitoPulizia>
  /** Rimette in libreria (e i file spostati tornano al loro posto). */
  rimettiInLibreria(ids: number[]): Promise<EsitoPulizia>
  /** Analisi dei titoli con l'AI locale (rifai = da capo su tutta la musica). */
  aiTitoliStatus(): Promise<AiTitoliStatus>
  aiTitoliStart(rifai?: boolean): Promise<AiTitoliStatus>
  aiTitoliStop(): Promise<void>
  onAiTitoliStatus(cb: (s: AiTitoliStatus) => void): () => void
  toltiDallaLibreria(text: string): Promise<{ tracks: (Track & { origPath: string })[]; total: number }>
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
  expandEvent(event: ScheduledEvent, ctx?: AnnounceCtx): Promise<EngineStep[]>
  /** Sceglie un file di playlist o una cartella. */
  choosePath(kind: 'playlist' | 'folder' | 'audio'): Promise<string | null>
  /** Prova una fonte di notiziari: scarica come all'ora dell'evento e restituisce il brano da ascoltare. */
  newsTest(source: NewsSource): Promise<{ track: Track | null; note: string }>
  /** Voci della voce sintetica, con lo stato (scaricata o no). */
  voiceList(): Promise<VoiceState[]>
  voiceInstall(id: string): Promise<VoiceState[]>
  voiceRemove(id: string): Promise<VoiceState[]>
  /** Prova un annuncio: restituisce il brano da ascoltare in preascolto. */
  voiceTest(text: string, voice?: VoiceSettings, ctx?: AnnounceCtx): Promise<{ track: Track | null; note: string }>
  logEnd(logId: number, at: string, playedSeconds: number): Promise<void>
  listLog(from: string, to: string): Promise<LogEntry[]>
  exportLogCsv(from: string, to: string): Promise<string | null>
  /** Report SIAE del trimestre (q = 1..4), dopo aver scaricato i brani suonati dal server. */
  siaeReport(year: number, q: number): Promise<{ rows: SiaeRow[]; serverError: string | null }>
  exportSiaeCsv(year: number, q: number): Promise<string | null>
  /** Musica a cui mancano autori, editore o un codice. */
  incompleteMusic(): Promise<{ tracks: Track[]; total: number }>
  mbStatus(): Promise<MbStatus>
  mbStart(): Promise<void>
  mbStop(): Promise<void>
  mbRetry(): Promise<MbStatus>
  onMbStatus(cb: (s: MbStatus) => void): () => void
  /** Discogs e Last.fm. */
  tagStatus(): Promise<TagStatus[]>
  tagStart(s: TagService): Promise<void>
  tagStop(s: TagService): Promise<void>
  tagRetry(s: TagService): Promise<TagStatus>
  onTagStatus(cb: (s: TagStatus) => void): () => void

  // rotazioni generate dall'AI
  aiStatus(): Promise<AiStatus>
  aiDownload(): Promise<void>
  aiCancelDownload(): Promise<void>
  aiRemoveModel(): Promise<void>
  aiGenerate(description: string): Promise<AiResult>
  aiCancelGenerate(): Promise<void>
  aiPreview(plan: AiPlan): Promise<AiResult>
  aiApply(plan: AiPlan, replace: boolean): Promise<ScheduledEvent[]>
  onAiStatus(cb: (s: AiStatus) => void): () => void

  onLibraryStatus(cb: (s: LibraryStatus) => void): () => void

  // ponte
  ponteStatus(): Promise<PonteStatus>
  /** Cattura dell'audio da inviare al ponte avviata/fermata. */
  ponteCapture(active: boolean, sampleRate: number): Promise<void>
  /** PCM s16le stereo interleaved da inviare al ponte. */
  sendPcm(pcm: ArrayBuffer): void
  ponteReport(r: StudioReport): Promise<void>
  ponteBackupNow(): Promise<string>
  ponteListBackups(): Promise<PonteBackup[]>
  ponteState(): Promise<PonteState>
  ponteListPrograms(): Promise<PonteProgram[]>
  ponteListeners(periodo: 'giorno' | 'settimana', data: string): Promise<ListenerStats>
  ponteReplay(programId: string, episodeId?: string): Promise<Track | null>
  ponteTestNotification(): Promise<{ ok: boolean; results: { channel: string; ok: boolean; error?: string }[] }>
  /** Scarica il backup e riavvia il programma per ripristinarlo. */
  ponteRestore(name: string): Promise<void>
  /** Se all'avvio è stato ripristinato un backup: dove è stata messa la versione precedente. */
  restoredFrom(): Promise<string | null>
  /** Eventi con un comando esterno spenti dopo il ripristino. */
  restoredEventsOff(): Promise<string[]>
  onPonteStatus(cb: (s: PonteStatus) => void): () => void
  // aggiornamento della regia
  aggiornamentoStato(): Promise<AggiornamentoStato>
  aggiornamentoInstalla(): Promise<void>
  aggiornamentoControlla(): Promise<AggiornamentoStato>
  onAggiornamento(cb: (s: AggiornamentoStato) => void): () => void
  /** novità dell'aggiornamento appena installato (null se non c'è niente da mostrare) */
  novitaInstallate(): Promise<NovitaInstallate | null>
  novitaLette(): Promise<void>
  // libreria del server (diretta autonoma)
  serverSyncStatus(): Promise<ServerSyncStatus>
  serverSyncList(filter: 'esclusi' | 'tutti', q: string): Promise<ServerTrackRow[]>
  /** Scelta a mano: true = sul server, false = no, null = decide la regola. */
  serverSyncChoice(id: number, choice: boolean | null): Promise<void>
  serverSyncNow(): Promise<string>
  /** Esegue le cancellazioni sul server rimaste in attesa di conferma (più di 20 in una volta). */
  serverSyncConfirmRemove(): Promise<string>
  serverSyncStop(): Promise<void>
  /** Copia la selezione su un disco scelto dall'utente; null se annullato. */
  serverSyncExport(): Promise<string | null>
  onServerSyncStatus(cb: (s: ServerSyncStatus) => void): () => void
  /** Stato della regia per il pannello remoto. */
  sendRemoteState(state: RemoteState): void
  /** Comandi dal pannello remoto: la funzione restituisce la risposta. */
  onRemoteCommand(cb: (cmd: RemoteCommand, by: string) => Promise<unknown>): () => void
}

declare global {
  interface Window {
    radio: RadioApi
  }
}
