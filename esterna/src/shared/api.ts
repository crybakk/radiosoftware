// Tipi condivisi tra la finestra (renderer) e il processo principale dell'app Radio Esterna.
import type { EsternaStatus, LineaStato } from '../../../ponte/controllo/src/protocol.ts'
import type { StatoRegistrazioneProgrammi } from '../../../src/core/registrazioneProgrammi.ts'

export type { EsternaStatus, LineaStato, StatoRegistrazioneProgrammi }

/** Un ingresso del mixer (microfono o canale di una scheda audio). */
export interface Canale {
  id: string
  nome: string
  /** Id del dispositivo ('' = predefinito). */
  deviceId: string
  /** Quale parte del segnale: tutti e due i canali, solo il sinistro (1) o solo il destro (2). */
  parte: 'stereo' | 'sinistro' | 'destro'
  /** Volume in dB (-60 … +12). */
  volumeDb: number
  muto: boolean
}

export interface ImpostazioniMixer {
  canali: Canale[]
  /** Audio del computer (tutto quello che suona sul PC). */
  pc: { attivo: boolean; volumeDb: number; muto: boolean; inCuffia: boolean }
  /** Uscita cuffia ('' = predefinita). */
  cuffiaId: string
  cuffiaVolume: number
  /** Ritorno dello studio in cuffia. */
  ritorno: boolean
  ritornoVolume: number
  /** Qualità dell'invio al server (kbit/s). */
  kbps: 96 | 128 | 160 | 256
}

export interface Impostazioni {
  /** Indirizzo del server, es. https://radio.esempio.it:9443 */
  server: string
  utente: string
  /** C'è una sessione salvata (il token non esce dal processo principale). */
  accesso: boolean
  mixer: ImpostazioniMixer
  programId: string | null
  testo: string
  /** Cartella delle registrazioni solo sul computer. */
  cartellaRegistrazioni: string
}

/** Messaggi WebRTC dal processo principale: connessione nuova (si prova il WebRTC), risposta, errore. */
export type MessaggioRtc = { t: 'nuova' } | { t: 'risposta'; sdp: string } | { t: 'errore'; messaggio: string }

export type StatoCollegamento = 'scollegato' | 'collegamento' | 'collegato' | 'errore'

export interface StatoServer {
  collegamento: StatoCollegamento
  messaggio: string
  /** Utente collegato (e ruolo). */
  utente: string | null
  stazione: string
  esterna: EsternaStatus | null
  /** La regia dello studio è collegata al server. */
  regia: boolean
  /** Indirizzo del ritorno dello studio (con il token), null se non collegati. */
  ritornoUrl: string | null
  /** Indirizzo del pannello (scheda Regia). */
  pannelloUrl: string | null
  /** Byte d'audio mandati negli ultimi secondi (kbit/s). */
  kbps: number
  /** Collegamento caduto mentre si era in onda: l'app riprova da sola. */
  caduto: boolean
}

export interface Programma {
  id: string
  title: string
}

/** Registrazione solo sul computer (senza puntata). */
export interface StatoRegistrazioneLocale {
  attiva: boolean
  file: string | null
  inizio: number | null
  byte: number
  problema: string | null
  /** Ultimo file finito. */
  ultimo: string | null
}

export interface AggiornamentoStato {
  stato: 'nessuno' | 'disponibile' | 'scarico' | 'pronto' | 'errore'
  attuale: string
  versione?: string
  percentuale?: number
  errore?: string
  /** Sul Mac l'aggiornamento si scarica dal sito: indirizzo del file. */
  scarica?: string
  novita?: { versione: string; novita: string[] }[]
  controllo?: string
}

export interface EsternaApi {
  impostazioni(): Promise<Impostazioni>
  salvaMixer(m: ImpostazioniMixer): Promise<void>
  accedi(server: string, utente: string, password: string): Promise<Impostazioni>
  esci(): Promise<Impostazioni>
  stato(): Promise<StatoServer>
  onStato(cb: (s: StatoServer) => void): () => void
  programmi(): Promise<Programma[]>
  meta(programId: string | null, testo: string): Promise<void>
  onda(on: boolean): Promise<void>
  /** Pezzo d'audio per il server (WebM/Opus). `inizio` = primo pezzo di un flusso nuovo. */
  audio(pezzo: ArrayBuffer, inizio: boolean): void
  /** Il processo principale chiede di ricominciare il flusso (nuova connessione): si riparte con l'intestazione. */
  onRiavviaInvio(cb: () => void): () => void
  /** WebRTC (26/11/2026): offerta al server, rinuncia (si torna all'HTTPS), messaggi dal server. */
  rtcOfferta(sdp: string): void
  rtcChiudi(): void
  onRtc(cb: (m: MessaggioRtc) => void): () => void
  // registrazione della puntata (come la regia dello studio)
  registrazione(): Promise<StatoRegistrazioneProgrammi>
  onRegistrazione(cb: (s: StatoRegistrazioneProgrammi) => void): () => void
  registra(programId: string): Promise<StatoRegistrazioneProgrammi>
  segnaInizio(): Promise<StatoRegistrazioneProgrammi>
  fineProgramma(): Promise<StatoRegistrazioneProgrammi>
  // registrazione solo sul computer
  registraLocale(on: boolean): Promise<StatoRegistrazioneLocale>
  statoLocale(): Promise<StatoRegistrazioneLocale>
  onLocale(cb: (s: StatoRegistrazioneLocale) => void): () => void
  /** Pezzo d'audio da registrare sul computer (WebM/Opus ad alta qualità). */
  pezzoRegistrazione(pezzo: ArrayBuffer): void
  /** Il processo principale chiede di avviare (true) o fermare i pezzi ad alta qualità per la registrazione. */
  onPezzi(cb: (on: boolean) => void): () => void
  apriCartella(): Promise<void>
  scegliCartella(): Promise<Impostazioni>
  // permessi (Mac)
  permessoMicrofono(): Promise<boolean>
  // aggiornamenti
  aggiornamento(): Promise<AggiornamentoStato>
  controllaAggiornamenti(): Promise<AggiornamentoStato>
  installaAggiornamento(): Promise<void>
  onAggiornamento(cb: (s: AggiornamentoStato) => void): () => void
  versione(): Promise<string>
  piattaforma: 'win32' | 'darwin' | 'linux'
  apriGuida(): Promise<void>
}

declare global {
  interface Window {
    esterna: EsternaApi
  }
}
