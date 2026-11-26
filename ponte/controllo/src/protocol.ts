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
  /** introLeft: secondi alla fine dell'intro (per parlarci sopra), null se finita o assente. */
  onAir: (RemoteTrack & { position: number; remaining: number; eventLabel?: string; introLeft?: number | null }) | null
  /** intro: secondi di intro del brano (0 = nessuna). */
  queue: (RemoteTrack & { uid: string; eta: string; origin: 'manual' | 'auto' | 'event'; eventLabel?: string; intro?: number })[]
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
  /** Eventi e rotazioni della regia (gestione da remoto): tutti rispondono con RemoteEventsInfo aggiornato. */
  | { type: 'events' }
  | { type: 'eventSave'; event: RemoteEventDraft }
  | { type: 'eventDelete'; id: number }
  | { type: 'eventEnable'; id: number; on: boolean }
  | { type: 'eventRun'; id: number }
  /** Cambia la rotazione attiva (null = rotazione normale, tutta la musica). */
  | { type: 'rotationSet'; profile: RemoteRotationProfile | null }
  /** Regole generali della rotazione. */
  | { type: 'rotationRules'; rules: Partial<RemoteRotationRules> }
  /** Rotazioni con l'AI della regia: la generazione può durare minuti, quindi parte e si controlla con aiStatus. */
  | { type: 'aiStatus' }
  | { type: 'aiGenerate'; description: string }
  | { type: 'aiCancel' }
  /** Ricontrolla un piano modificato a mano (risponde con il risultato aggiornato). */
  | { type: 'aiPreview'; plan: RemoteAiPlan }
  /** Crea gli eventi del piano (replace = toglie prima quelli creati dall'AI): risponde con RemoteEventsInfo. */
  | { type: 'aiApply'; plan: RemoteAiPlan; replace: boolean }

/** Profilo di rotazione (uguale a quello della regia). */
export interface RemoteRotationProfile {
  name: string
  genres: string[]
  yearFrom: number | null
  yearTo: number | null
  artistSeparationMinutes: number | null
  jingleEvery: number | null
  energyMin?: number | null
  energyMax?: number | null
}

export interface RemoteRotationRules {
  artistSeparationMinutes: number
  titleSeparationMinutes: number
  jingleEvery: number
}

/** Azioni di un evento (uguali a quelle della regia). */
export type RemoteEventAction =
  | { type: 'play'; trackId: number }
  | { type: 'random'; kind: RemoteKind | ''; folder: string; genre: string }
  | { type: 'playlist'; path: string; placement: 'front' | 'append' | 'replace' }
  | { type: 'stream'; url: string; minutes: number; title: string }
  | { type: 'mode'; mode: 'auto' | 'manual' }
  | { type: 'clear' }
  | { type: 'stop' }
  | { type: 'rotation'; profile: RemoteRotationProfile | null }
  /** Il testo del comando non esce dalla regia: arriva vuoto. */
  | { type: 'command'; command: string }
  | { type: 'replay'; programId: string; title: string }
  | { type: 'news'; sourceId: string; title: string }
  | { type: 'voice'; text: string }
  | { type: 'djMix'; on: boolean }

export interface RemoteEvent {
  id: number
  label: string
  time: string
  days: number[]
  repeatMinutes: number
  untilTime: string | null
  validFrom: string | null
  validTo: string | null
  mode: 'soft' | 'hard'
  toleranceSeconds: number
  actions: RemoteEventAction[]
  enabled: boolean
  /** Contiene un comando esterno: da remoto si vede soltanto (si gestisce dalla regia). */
  locked?: boolean
}

export type RemoteEventDraft = Omit<RemoteEvent, 'id' | 'locked'> & { id?: number }

/** Fascia oraria proposta dall'AI (uguale a quella della regia). */
export interface RemoteAiSlot {
  name: string
  days: number[]
  start: string
  end: string
  genres: string[]
  yearFrom: number | null
  yearTo: number | null
  artistSeparationMinutes: number | null
  jingleEvery: number | null
  energyMin?: number | null
  energyMax?: number | null
}

export interface RemoteAiPlan {
  slots: RemoteAiSlot[]
}

export interface RemoteAiResult {
  plan: RemoteAiPlan
  warnings: string[]
  /** Brani di musica per ogni fascia. */
  counts: number[]
  music: number
  seconds: number
}

/** Stato delle rotazioni con l'AI nella regia. */
export interface RemoteAiInfo {
  /** Modello scaricato nella regia (si scarica dalla regia: sono circa 2,5 GB). */
  installed: boolean
  modelName: string
  /** Ultimo palinsesto scritto. */
  description: string
  job: {
    state: 'libero' | 'in_corso' | 'pronto' | 'errore'
    by: string | null
    startedAt: string | null
    result: RemoteAiResult | null
    error: string | null
  }
}

/** Eventi e rotazioni della regia, per il pannello e per Telegram. */
export interface RemoteEventsInfo {
  events: RemoteEvent[]
  /** Prossime partenze (ora della regia). */
  next: { id: number; at: string }[]
  /** Rotazione attiva (null = normale). */
  rotation: RemoteRotationProfile | null
  /** Profili di rotazione usati negli eventi, da scegliere al volo. */
  profiles: RemoteRotationProfile[]
  rules: RemoteRotationRules
  djMix: boolean
  /** Fonti dei notiziari della regia. */
  news: { id: string; name: string }[]
  /** Brani usati negli eventi (azione "Brano"). */
  tracks: RemoteTrack[]
  /** Generi e categorie della libreria (per le rotazioni). */
  genres: string[]
  at: string
}

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
  /** Qualità della linea dell'ospite (null = audio non collegato). */
  linea?: LineaStato | null
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

/** App "Radio Esterna" (dirette da fuori): stato per regia, pannello e app. */
export interface EsternaStatus {
  /** L'app è collegata al server. */
  collegata: boolean
  /** L'audio dell'app arriva al mixer del ponte. */
  audio: boolean
  /** Chi usa l'app. */
  user: string | null
  /** Chi è fuori ha premuto IN ONDA. */
  inOnda: boolean
  /** In onda e con l'audio che arriva: si sente alla radio. */
  inOndaDavvero: boolean
  /** Titolo in onda: "Programma – riga libera". */
  titolo: string
  programId: string | null
  /** In onda dalle (ISO). */
  since: string | null
  /** Token per ascoltare l'app (GET /api/esterna/ascolta?t=…), null se non è collegata. */
  ascolto: string | null
  /** Come arriva l'audio dell'app: WebRTC (UDP) o HTTPS (riserva). null = non collegata. */
  via?: 'webrtc' | 'https' | null
  /** Qualità della linea dell'app (null = non collegata o ancora da misurare). */
  linea?: LineaStato | null
}

/** Regia → ponte */
export type FromStudio =
  | { t: 'auth'; token: string }
  | { t: 'state'; state: RemoteState }
  | { t: 'reply'; id: string; ok: boolean; data?: unknown; error?: string }

/** Ponte → regia */
export type ToStudio =
  | { t: 'auth-ok' }
  | { t: 'cmd'; id: string; cmd: RemoteCommand; by: string }
  /** Segnale di vita ogni 15 secondi: la regia lo può ignorare (le versioni vecchie ignorano i tipi sconosciuti). */
  | { t: 'ping' }
  /** App Radio Esterna collegata, in onda o no (le regie vecchie ignorano i tipi sconosciuti). */
  | { t: 'esterna'; esterna: EsternaStatus }

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

/** Qualità della linea di una voce o dell'esterna (indicatore verde/giallo/rosso, scelte del 26/11/2026). */
export type LivelloLinea = 'buona' | 'debole' | 'pessima' | 'assente'
export interface LineaStato {
  livello: LivelloLinea
  /** Frase per chi non sa niente di tecnica. */
  frase: string
  /** Pacchetti persi o arrivati tardi sulla rete (%), prima della correzione. */
  perdita: number
  /** Audio che si è dovuto inventare (%): sono i salti che si possono sentire. */
  buchi: number
  /** Ritardo del buffer (ms). */
  ritardo: number
}

export interface MicStatus {
  /** Chi ha il microfono aperto (null = nessuno). */
  user: string | null
  onAir: boolean
  /** Qualità della linea (null = microfono chiuso). */
  linea?: LineaStato | null
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
  | { t: 'esterna'; esterna: EsternaStatus }
