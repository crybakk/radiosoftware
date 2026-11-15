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
  /** Profilo di rotazione attivo, impostato dagli eventi (null = rotazione normale). */
  rotationProfile: RotationProfile | null
  /** Collegamento con il server ponte (invio del programma, allarmi, backup). */
  ponte: PonteSettings
}

export interface PonteSettings {
  /** Invio del programma al ponte acceso. */
  enabled: boolean
  /** Indirizzo del server ponte (nome o IP): il dominio della radio. */
  host: string
  srtPort: number
  /** Frase segreta SRT, uguale a SRT_PASSPHRASE del ponte. */
  passphrase: string
  /** Margine contro i buchi del 4G, in millisecondi. */
  latencyMs: number
  bitrateKbps: number
  /** Cosa inviare: il solo programma del computer o un ingresso della scheda audio (es. il mix del RodeCaster). */
  source: 'programma' | 'ingresso'
  /** Ingresso audio usato quando source = 'ingresso' ('' = predefinito). */
  inputDeviceId: string
  /** Porta del servizio di controllo del ponte. */
  controlPort: number
  /** Token del servizio di controllo, uguale a CONTROLLO_TOKEN del ponte. */
  controlToken: string
  /** Il servizio di controllo usa HTTPS (Caddy, porta 443). */
  controlHttps: boolean
  /** Permette di comandare la regia dal pannello remoto. */
  remoteControl: boolean
  /** Invia artista e titolo dei brani agli Icecast. */
  sendMetadata: boolean
  /** Ora del backup automatico giornaliero (0-23, -1 = mai). */
  backupHour: number
  /** Invia da solo al server i brani nuovi della selezione (di notte, entro il limite giornaliero). */
  librarySync: boolean
  /** Sotto questa qualità (kbps) un brano non va sul server. */
  libraryMinKbps: number
  /** Massimo di MB caricati sul server in un giorno (traffico 4G). */
  libraryDailyMb: number
  /** Ore in cui si può caricare: dalle ... alle ... (es. 1 e 6). */
  librarySyncFrom: number
  librarySyncTo: number
}

export const DEFAULT_PONTE: PonteSettings = {
  enabled: false,
  host: '',
  srtPort: 9000,
  passphrase: '',
  latencyMs: 2000,
  bitrateKbps: 128,
  source: 'programma',
  inputDeviceId: '',
  controlPort: 443,
  controlToken: '',
  controlHttps: true,
  remoteControl: true,
  sendMetadata: true,
  backupHour: 4,
  librarySync: true,
  libraryMinKbps: 192,
  libraryDailyMb: 1024,
  librarySyncFrom: 1,
  librarySyncTo: 6
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
  cartwall: Array(12).fill(null),
  rotationProfile: null,
  ponte: DEFAULT_PONTE
}

/** Profilo di rotazione attivato da un evento (per esempio "dalle 22 musica tranquilla"). */
export interface RotationProfile {
  name: string
  /** Generi ammessi (basta che il genere del brano ne contenga uno). Vuoto = tutti. */
  genres: string[]
  yearFrom: number | null
  yearTo: number | null
  /** Se impostati, sostituiscono quelli delle impostazioni generali. */
  artistSeparationMinutes: number | null
  jingleEvery: number | null
}

/** Una singola azione di un evento. Le azioni vengono eseguite in ordine. */
export type EventAction =
  | { type: 'play'; trackId: number }
  | { type: 'random'; kind: TrackKind | ''; folder: string; genre: string }
  | { type: 'playlist'; path: string; placement: 'front' | 'append' | 'replace' }
  | { type: 'stream'; url: string; minutes: number; title: string }
  | { type: 'mode'; mode: 'auto' | 'manual' }
  | { type: 'clear' }
  | { type: 'stop' }
  | { type: 'rotation'; profile: RotationProfile | null }
  | { type: 'command'; command: string }
  /** Replica: l'ultima puntata pubblicata del programma (dal server). */
  | { type: 'replay'; programId: string; title: string }

export const ACTION_LABELS: Record<EventAction['type'], string> = {
  play: 'Brano',
  random: 'Brano casuale',
  playlist: 'Playlist',
  stream: 'Flusso esterno',
  mode: 'Automatico / manuale',
  clear: 'Svuota coda',
  stop: 'Ferma tutto',
  rotation: 'Regole di rotazione',
  command: 'Comando esterno',
  replay: 'Replica di un programma'
}

/** Evento a orario fisso. */
export interface ScheduledEvent {
  id: number
  label: string
  /** Orario "HH:MM" di partenza, oppure "*:MM" per ogni ora al minuto MM. */
  time: string
  /** Giorni attivi, 0 = domenica ... 6 = sabato. */
  days: number[]
  /** Se > 0, l'evento si ripete ogni N minuti a partire da `time` fino a `untilTime`. */
  repeatMinutes: number
  /** "HH:MM" di fine delle ripetizioni (null = fino a mezzanotte). */
  untilTime: string | null
  /** Date di validità "YYYY-MM-DD" (null = sempre). */
  validFrom: string | null
  validTo: string | null
  /**
   * Come parte rispetto al brano in onda:
   * 'soft' = dopo il brano (se toleranceSeconds > 0, aspetta al massimo quei secondi e poi sfuma);
   * 'hard' = subito, sfumando il brano in onda.
   */
  mode: 'soft' | 'hard'
  toleranceSeconds: number
  actions: EventAction[]
  enabled: boolean
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
  /** Nome dell'evento che l'ha inserito. */
  eventLabel?: string
}

export function gainForTrack(track: Pick<Track, 'loudness'>, targetLoudness: number): number {
  if (track.loudness == null || !Number.isFinite(track.loudness)) return 0
  const gain = targetLoudness - track.loudness
  // Limiti: non alzare troppo i brani bassi (rumore) né abbassare oltre misura.
  return Math.max(-12, Math.min(6, gain))
}
