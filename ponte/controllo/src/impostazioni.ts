/**
 * Impostazioni del server modificabili dal pannello (solo amministratori).
 *
 * I valori stanno nel file .env del server, montato nel contenitore. Il pannello li legge e li salva
 * qui: il file si riscrive conservando commenti e ordine. Per applicarli si lascia una richiesta nella
 * cartella condivisa con il server: un servizio di sistema sul server (installato da installa-server.sh)
 * la vede e lancia "docker compose up -d", che riavvia soltanto le parti con valori cambiati.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Parti del server che ripartono quando cambia un valore (per avvisare prima di salvare). */
export type Parte = 'audio' | 'icecast' | 'pannello' | 'https'

export const NOMI_PARTI: Record<Parte, string> = {
  audio: 'audio della radio',
  icecast: 'Icecast principale (gli ascoltatori si ricollegano)',
  pannello: 'pannello',
  https: 'HTTPS'
}

export interface Voce {
  chiave: string
  gruppo: string
  etichetta: string
  tipo: 'testo' | 'password' | 'numero' | 'sino' | 'scelta'
  aiuto?: string
  opzioni?: string[]
  min?: number
  max?: number
  /** il valore deve rispettare questa forma (se non è vuoto) */
  forma?: RegExp
  formaErrore?: string
  /** può restare vuoto */
  vuoto?: boolean
  predefinito: string
  parti: Parte[]
  /** valori che, se sbagliati, staccano regia o pannello: si cambiano solo con "Modifica avanzata" */
  avanzato?: boolean
}

const PORTA = { tipo: 'numero' as const, min: 1, max: 65535 }
const SECONDI = { tipo: 'numero' as const, min: 1, max: 3600 }
const FRASE = { forma: /^.{10,79}$/, formaErrore: 'da 10 a 79 caratteri', vuoto: true }

export const VOCI: Voce[] = [
  // --- Radio ---
  { chiave: 'NOME_RADIO', gruppo: 'Radio', etichetta: 'Nome della radio', tipo: 'testo', predefinito: 'Radio', parti: ['audio', 'icecast', 'pannello'] },
  { chiave: 'DESCRIZIONE_RADIO', gruppo: 'Radio', etichetta: 'Descrizione della radio', tipo: 'testo', vuoto: true, predefinito: '', parti: ['pannello'], aiuto: 'Compare nel podcast e nelle pagine per gli ascoltatori.' },
  { chiave: 'ICECAST_BITRATE', gruppo: 'Radio', etichetta: 'Qualità MP3 (kbit/s)', tipo: 'scelta', opzioni: ['64', '96', '128', '160', '192', '256', '320'], predefinito: '128', parti: ['audio', 'pannello'], aiuto: 'Uguale per l\'Icecast principale e il secondario. Ogni ascoltatore usa questa banda in upload.' },
  { chiave: 'ICECAST_MAX_ASCOLTATORI', gruppo: 'Radio', etichetta: 'Ascoltatori al massimo', tipo: 'numero', min: 1, max: 100000, predefinito: '1000', parti: ['icecast'] },
  { chiave: 'PROCESSORE_AUDIO', gruppo: 'Radio', etichetta: 'Processore audio', tipo: 'scelta', opzioni: ['spento', 'leggero', 'medio', 'forte'], predefinito: 'medio', parti: ['audio'] },
  { chiave: 'SRT_BUFFER_SECONDS', gruppo: 'Radio', etichetta: 'Secondi di audio tenuti in memoria (contro i buchi del 4G)', tipo: 'numero', min: 1, max: 60, predefinito: '10', parti: ['audio'] },
  { chiave: 'BACKUP_DA_TENERE', gruppo: 'Radio', etichetta: 'Copie di backup della regia da tenere', tipo: 'numero', min: 1, max: 365, predefinito: '14', parti: ['pannello'] },

  // --- Dirette esterne ---
  { chiave: 'ESTERNA_MOUNT', gruppo: 'Dirette esterne', etichetta: 'Mount', tipo: 'testo', forma: /^\/[A-Za-z0-9._~\/-]*$/, formaErrore: 'deve iniziare con / e avere solo lettere, numeri e . _ ~ / -', predefinito: '/', parti: ['audio'] },
  { chiave: 'ESTERNA_UTENTE', gruppo: 'Dirette esterne', etichetta: 'Utente', tipo: 'testo', forma: /^\S+$/, formaErrore: 'senza spazi', predefinito: 'esterna', parti: ['audio'] },
  { chiave: 'ESTERNA_PASSWORD', gruppo: 'Dirette esterne', etichetta: 'Password', tipo: 'password', vuoto: true, predefinito: '', parti: ['audio'], aiuto: 'Vuota = ingresso delle dirette esterne spento.' },

  // --- Icecast secondario ---
  { chiave: 'ICECAST_ESTERNO_HOST', gruppo: 'Icecast secondario', etichetta: 'Indirizzo del server', tipo: 'testo', forma: /^[A-Za-z0-9.-]+$/, formaErrore: 'solo il nome o l\'IP, senza http:// e senza porta', vuoto: true, predefinito: '', parti: ['audio', 'pannello'], aiuto: 'Vuoto = Icecast secondario spento.' },
  { chiave: 'ICECAST_ESTERNO_PORTA', gruppo: 'Icecast secondario', etichetta: 'Porta', ...PORTA, predefinito: '8000', parti: ['audio', 'pannello'] },
  { chiave: 'ICECAST_ESTERNO_MOUNT', gruppo: 'Icecast secondario', etichetta: 'Mount', tipo: 'testo', forma: /^\/[A-Za-z0-9._~\/-]+$/, formaErrore: 'deve iniziare con / e avere solo lettere, numeri e . _ ~ / -', predefinito: '/radio.mp3', parti: ['audio', 'pannello'] },
  { chiave: 'ICECAST_ESTERNO_UTENTE', gruppo: 'Icecast secondario', etichetta: 'Utente per trasmettere', tipo: 'testo', predefinito: 'source', parti: ['audio'] },
  { chiave: 'ICECAST_ESTERNO_PASSWORD', gruppo: 'Icecast secondario', etichetta: 'Password per trasmettere', tipo: 'password', vuoto: true, predefinito: '', parti: ['audio'] },
  { chiave: 'ICECAST_ESTERNO_ADMIN_UTENTE', gruppo: 'Icecast secondario', etichetta: 'Utente amministratore (statistiche)', tipo: 'testo', vuoto: true, predefinito: 'admin', parti: ['pannello'], aiuto: 'Serve solo se la pagina pubblica di stato del secondario è chiusa.' },
  { chiave: 'ICECAST_ESTERNO_ADMIN_PASSWORD', gruppo: 'Icecast secondario', etichetta: 'Password amministratore (statistiche)', tipo: 'password', vuoto: true, predefinito: '', parti: ['pannello'] },

  // --- Microfono remoto e ospiti ---
  { chiave: 'MICROFONO_REMOTO', gruppo: 'Microfono remoto e ospiti', etichetta: 'Microfono remoto dal pannello', tipo: 'sino', predefinito: 'si', parti: ['audio', 'pannello'] },
  { chiave: 'ABBASSAMENTO_MUSICA_DB', gruppo: 'Microfono remoto e ospiti', etichetta: 'Abbassamento della musica col microfono aperto (dB)', tipo: 'numero', min: -60, max: 0, predefinito: '-12', parti: ['audio'] },
  { chiave: 'WEBRTC_STUN', gruppo: 'Microfono remoto e ospiti', etichetta: 'Server STUN', tipo: 'testo', forma: /^stuns?:\S+$/, formaErrore: 'deve iniziare con stun:', vuoto: true, predefinito: 'stun:stun.l.google.com:19302', parti: ['pannello'] },
  { chiave: 'WEBRTC_INDIRIZZI', gruppo: 'Microfono remoto e ospiti', etichetta: 'Indirizzi in più (separati da virgola)', tipo: 'testo', forma: /^[A-Za-z0-9.:,\s-]+$/, formaErrore: 'nomi o IP separati da virgola', vuoto: true, predefinito: '', parti: ['pannello'], aiuto: 'Per esempio l\'IP del server nella rete di casa.' },
  { chiave: 'ASCOLTO_URL', gruppo: 'Microfono remoto e ospiti', etichetta: 'Indirizzo di ascolto per gli ospiti in attesa', tipo: 'testo', forma: /^https?:\/\/\S+$/, formaErrore: 'deve iniziare con http:// o https://', vuoto: true, predefinito: '', parti: ['pannello'], aiuto: 'Vuoto = l\'ascolto dell\'Icecast principale.' },

  // --- Dirette video ---
  { chiave: 'DIRETTE_VIDEO', gruppo: 'Dirette video', etichetta: 'Dirette su YouTube e Facebook', tipo: 'sino', predefinito: 'si', parti: ['pannello'], aiuto: 'Le chiavi delle dirette e il logo si impostano nella sezione Dirette video.' },
  { chiave: 'VIDEO_OBS_PASSPHRASE', gruppo: 'Dirette video', etichetta: 'Frase segreta per OBS', tipo: 'password', ...FRASE, predefinito: '', parti: ['pannello'], aiuto: 'Da 10 a 79 caratteri. Vuota = nessuna cifratura.' },

  // --- Riconoscimento e puntate ---
  { chiave: 'RICONOSCIMENTO', gruppo: 'Riconoscimento brani e puntate', etichetta: 'Riconoscimento dei brani nelle dirette esterne', tipo: 'sino', predefinito: 'si', parti: ['pannello'] },
  { chiave: 'REGISTRAZIONE_PUNTATE', gruppo: 'Riconoscimento brani e puntate', etichetta: 'Registrazione delle puntate', tipo: 'sino', predefinito: 'si', parti: ['pannello'] },
  { chiave: 'PUNTATE_BITRATE', gruppo: 'Riconoscimento brani e puntate', etichetta: 'Qualità delle puntate registrate', tipo: 'scelta', opzioni: ['64k', '96k', '128k', '160k', '192k', '256k', '320k'], predefinito: '128k', parti: ['pannello'], aiuto: '128k ≈ 58 MB all\'ora.' },

  // --- Allarmi ---
  { chiave: 'ALLARME_SILENZIO_SECONDI', gruppo: 'Allarmi', etichetta: 'Silenzio in onda (secondi)', ...SECONDI, predefinito: '20', parti: ['audio'] },
  { chiave: 'ALLARME_SCOLLEGATO_SECONDI', gruppo: 'Allarmi', etichetta: 'Regia scollegata (secondi)', ...SECONDI, predefinito: '30', parti: ['pannello'] },
  { chiave: 'ALLARME_REGIA_MUTA_SECONDI', gruppo: 'Allarmi', etichetta: 'Regia collegata ma muta (secondi)', ...SECONDI, predefinito: '90', parti: ['pannello'] },
  { chiave: 'ALLARME_RICONNESSIONI', gruppo: 'Allarmi', etichetta: 'Riconnessioni della regia in 10 minuti', tipo: 'numero', min: 1, max: 1000, predefinito: '5', parti: ['pannello'] },
  { chiave: 'TELEGRAM_BOT_TOKEN', gruppo: 'Allarmi', etichetta: 'Telegram allarmi: token del bot', tipo: 'password', vuoto: true, predefinito: '', parti: ['pannello'], aiuto: 'Dal bot @BotFather. Vuoto = niente allarmi su Telegram.' },
  { chiave: 'TELEGRAM_CHAT_ID', gruppo: 'Allarmi', etichetta: 'Telegram allarmi: id della chat', tipo: 'testo', forma: /^-?\d+$|^@\w+$/, formaErrore: 'un numero (anche negativo) o @nomecanale', vuoto: true, predefinito: '', parti: ['pannello'] },
  { chiave: 'TELEGRAM_ETICHETTE_TOKEN', gruppo: 'Allarmi', etichetta: 'Bot Telegram della radio: token', tipo: 'password', vuoto: true, predefinito: '', parti: ['pannello'], aiuto: 'Il bot per etichettare i brani sconosciuti e vedere lo stato (diverso da quello degli allarmi).' },
  { chiave: 'TELEGRAM_ETICHETTE_CHAT_ID', gruppo: 'Allarmi', etichetta: 'Bot Telegram della radio: id della chat', tipo: 'testo', forma: /^-?\d+$|^@\w+$/, formaErrore: 'un numero (anche negativo) o @nomecanale', vuoto: true, predefinito: '', parti: ['pannello'] },
  { chiave: 'SMTP_HOST', gruppo: 'Allarmi', etichetta: 'Email: server SMTP', tipo: 'testo', forma: /^[A-Za-z0-9.-]+$/, formaErrore: 'solo il nome del server', vuoto: true, predefinito: '', parti: ['pannello'], aiuto: 'Vuoto = niente allarmi via email.' },
  { chiave: 'SMTP_PORTA', gruppo: 'Allarmi', etichetta: 'Email: porta', ...PORTA, predefinito: '587', parti: ['pannello'] },
  { chiave: 'SMTP_SSL', gruppo: 'Allarmi', etichetta: 'Email: SSL (di solito sì con la porta 465)', tipo: 'sino', predefinito: 'no', parti: ['pannello'] },
  { chiave: 'SMTP_UTENTE', gruppo: 'Allarmi', etichetta: 'Email: utente', tipo: 'testo', vuoto: true, predefinito: '', parti: ['pannello'] },
  { chiave: 'SMTP_PASSWORD', gruppo: 'Allarmi', etichetta: 'Email: password', tipo: 'password', vuoto: true, predefinito: '', parti: ['pannello'] },
  { chiave: 'EMAIL_MITTENTE', gruppo: 'Allarmi', etichetta: 'Email: mittente', tipo: 'testo', vuoto: true, predefinito: '', parti: ['pannello'] },
  { chiave: 'EMAIL_DESTINATARI', gruppo: 'Allarmi', etichetta: 'Email: destinatari (separati da virgola)', tipo: 'testo', vuoto: true, predefinito: '', parti: ['pannello'] },

  // --- Avanzate: se sbagliate, regia o pannello non si collegano più ---
  { chiave: 'DOMINIO', gruppo: 'Avanzate', etichetta: 'Dominio della radio', tipo: 'testo', forma: /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, formaErrore: 'un nome come radio.esempio.it', predefinito: '', parti: ['https', 'icecast', 'pannello'], avanzato: true, aiuto: 'Deve puntare all\'IP di casa. Se sbagliato il pannello non si apre più con il nome.' },
  { chiave: 'SRT_PORT', gruppo: 'Avanzate', etichetta: 'Porta SRT dalla regia (UDP)', ...PORTA, predefinito: '9000', parti: ['audio'], avanzato: true, aiuto: 'Va cambiata anche nella regia e sul router.' },
  { chiave: 'SRT_PASSPHRASE', gruppo: 'Avanzate', etichetta: 'Frase segreta SRT', tipo: 'password', ...FRASE, predefinito: '', parti: ['audio'], avanzato: true, aiuto: 'Va cambiata anche nella regia.' },
  { chiave: 'CONTROLLO_TOKEN', gruppo: 'Avanzate', etichetta: 'Token della regia', tipo: 'password', forma: /^\S{16,}$/, formaErrore: 'almeno 16 caratteri, senza spazi', predefinito: '', parti: ['pannello'], avanzato: true, aiuto: 'Va cambiato anche nella regia.' },
  { chiave: 'ESTERNA_PORTA', gruppo: 'Avanzate', etichetta: 'Porta delle dirette esterne (TCP)', ...PORTA, predefinito: '9010', parti: ['audio'], avanzato: true, aiuto: 'Va cambiata anche sul router e nelle app delle esterne.' },
  { chiave: 'ICECAST_PORTA', gruppo: 'Avanzate', etichetta: 'Porta HTTP diretta di Icecast', ...PORTA, predefinito: '8000', parti: ['icecast'], avanzato: true },
  { chiave: 'ICECAST_MOUNT', gruppo: 'Avanzate', etichetta: 'Mount dell\'ascolto', tipo: 'testo', forma: /^\/[A-Za-z0-9._~\/-]+$/, formaErrore: 'deve iniziare con / e avere solo lettere, numeri e . _ ~ / -', predefinito: '/radio.mp3', parti: ['audio', 'https', 'pannello'], avanzato: true, aiuto: 'Cambia l\'indirizzo di ascolto: i link già dati agli ascoltatori smettono di funzionare.' },
  { chiave: 'ICECAST_PASSWORD_SORGENTE', gruppo: 'Avanzate', etichetta: 'Password di Icecast per trasmettere', tipo: 'password', forma: /^\S+$/, formaErrore: 'senza spazi', predefinito: '', parti: ['audio', 'icecast'], avanzato: true },
  { chiave: 'ICECAST_PASSWORD_ADMIN', gruppo: 'Avanzate', etichetta: 'Password di amministrazione di Icecast', tipo: 'password', forma: /^\S+$/, formaErrore: 'senza spazi', predefinito: '', parti: ['icecast'], avanzato: true },
  { chiave: 'ICECAST_PASSWORD_RELAY', gruppo: 'Avanzate', etichetta: 'Password di Icecast per i relay', tipo: 'password', forma: /^\S+$/, formaErrore: 'senza spazi', predefinito: '', parti: ['icecast'], avanzato: true },
  { chiave: 'WEBRTC_PORTE', gruppo: 'Avanzate', etichetta: 'Porte UDP del microfono remoto e degli ospiti', tipo: 'testo', forma: /^\d{1,5}-\d{1,5}$/, formaErrore: 'nella forma 40000-40049', predefinito: '40000-40049', parti: ['pannello'], avanzato: true, aiuto: 'Vanno cambiate anche sul router.' },
  { chiave: 'VIDEO_OBS_PORTA', gruppo: 'Avanzate', etichetta: 'Porta UDP del video da OBS', ...PORTA, predefinito: '9020', parti: ['pannello'], avanzato: true, aiuto: 'Va cambiata anche sul router e in OBS.' }
]

const PER_CHIAVE = new Map(VOCI.map((v) => [v.chiave, v]))

/**
 * Valore in uso: se manca nel file, o è vuoto per una voce che non può restare vuota, i servizi usano
 * il predefinito (in docker-compose.yml con ${CHIAVE:-predefinito}).
 */
function valoreAttuale(attuali: Record<string, string>, v: Omit<Voce, 'forma'>): string {
  const a = attuali[v.chiave]
  return a === undefined || (a === '' && !v.vuoto) ? v.predefinito : a
}

// ---------- lettura e scrittura del file .env ----------

/** Toglie le virgolette come fa Docker Compose (singole: testo così com'è; doppie: \" e \\). */
function togliVirgolette(v: string): string {
  const t = v.trim()
  // tra virgolette: quello che segue la virgoletta di chiusura (per esempio un commento) non conta
  const singole = /^'([^']*)'/.exec(t)
  if (singole) return singole[1]
  const doppie = /^"((?:[^"\\]|\\.)*)"/.exec(t)
  if (doppie) return doppie[1].replace(/\\(["\\])/g, '$1')
  // senza virgolette: " #" inizia un commento
  const i = t.search(/\s#/)
  return (i >= 0 ? t.slice(0, i) : t).trim()
}

/** Valori del file .env (l'ultimo vince, come in Docker Compose). */
export function leggiEnv(testo: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const riga of testo.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(riga)
    if (m) out[m[1]] = togliVirgolette(m[2])
  }
  return out
}

/** Valore pronto per il file: tra apici singoli se contiene caratteri che Compose interpreterebbe ($, #, spazi…). */
export function scriviValore(v: string): string {
  return /^[A-Za-z0-9_./:,@+-]*$/.test(v) ? v : `'${v}'`
}

/** Riscrive il file cambiando solo le righe dei valori dati; quelli che mancano si aggiungono in fondo. */
export function aggiornaEnv(testo: string, valori: Record<string, string>): string {
  const restano = new Set(Object.keys(valori))
  const righe = testo.split('\n').map((riga) => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/.exec(riga)
    if (!m || !(m[2] in valori)) return riga
    restano.delete(m[2])
    return `${m[1]}${m[2]}${m[3]}${scriviValore(valori[m[2]])}`
  })
  if (restano.size) {
    if (righe.length && righe[righe.length - 1] === '') righe.pop()
    for (const k of restano) righe.push(`${k}=${scriviValore(valori[k])}`)
    righe.push('')
  }
  return righe.join('\n')
}

// ---------- controllo dei valori ----------

export function controlla(voce: Voce, valore: unknown): string {
  if (typeof valore !== 'string') throw new Error(`${voce.etichetta}: valore non valido`)
  const v = valore.trim()
  if (/[\r\n']/.test(v)) throw new Error(`${voce.etichetta}: non può contenere a capo o apostrofi`)
  // tra apici, una \ in fondo per Docker Compose "protegge" l'apice di chiusura: il file .env non si leggerebbe più
  if (v.endsWith('\\')) throw new Error(`${voce.etichetta}: non può finire con \\`)
  if (v.length > 500) throw new Error(`${voce.etichetta}: troppo lungo`)
  if (!v) {
    if (voce.vuoto) return ''
    throw new Error(`${voce.etichetta}: non può restare vuoto`)
  }
  if (voce.tipo === 'numero') {
    const n = Number(v.replace(',', '.'))
    if (!Number.isFinite(n)) throw new Error(`${voce.etichetta}: deve essere un numero`)
    if ((voce.min !== undefined && n < voce.min) || (voce.max !== undefined && n > voce.max)) {
      throw new Error(`${voce.etichetta}: deve essere tra ${voce.min} e ${voce.max}`)
    }
    if (voce.min !== undefined && voce.min >= 1 && !Number.isInteger(n)) throw new Error(`${voce.etichetta}: deve essere un numero intero`)
    return String(n)
  }
  if (voce.tipo === 'sino') {
    if (v !== 'si' && v !== 'no') throw new Error(`${voce.etichetta}: sì o no`)
    return v
  }
  if (voce.tipo === 'scelta' && !voce.opzioni!.includes(v)) throw new Error(`${voce.etichetta}: scelta non valida`)
  if (voce.forma && !voce.forma.test(v)) throw new Error(`${voce.etichetta}: ${voce.formaErrore}`)
  return v
}

/** Controlli che riguardano più valori insieme. */
function controllaInsieme(tutti: Record<string, string>): void {
  const porte = ['SRT_PORT', 'ESTERNA_PORTA', 'ICECAST_PORTA', 'VIDEO_OBS_PORTA'].map((k) => [k, tutti[k]] as const)
  for (const [k, p] of porte) {
    if (p === '80' || p === '443') throw new Error(`${PER_CHIAVE.get(k)!.etichetta}: le porte 80 e 443 servono all'HTTPS`)
  }
  const tcp = new Set<string>()
  for (const k of ['ESTERNA_PORTA', 'ICECAST_PORTA']) {
    if (tcp.has(tutti[k])) throw new Error('La porta delle dirette esterne deve essere diversa da quella di Icecast')
    tcp.add(tutti[k])
  }
  const [da, a] = (tutti.WEBRTC_PORTE ?? '').split('-').map(Number)
  if (tutti.WEBRTC_PORTE && !(da >= 1024 && a <= 65535 && a >= da && a - da <= 1000)) {
    throw new Error('Porte UDP del microfono: un intervallo valido, per esempio 40000-40049')
  }
  for (const k of ['SRT_PORT', 'VIDEO_OBS_PORTA']) {
    const p = Number(tutti[k])
    if (tutti.WEBRTC_PORTE && p >= da && p <= a) throw new Error(`${PER_CHIAVE.get(k)!.etichetta}: è dentro le porte del microfono remoto`)
  }
  if (tutti.SRT_PORT && tutti.SRT_PORT === tutti.VIDEO_OBS_PORTA) throw new Error('La porta SRT della regia e quella di OBS devono essere diverse')
}

// ---------- servizio ----------

export interface VoceVista extends Omit<Voce, 'forma'> {
  valore: string
  /** per le password: c'è un valore (che non si manda al browser) */
  impostato?: boolean
}

export interface StatoApplica {
  /** ultima richiesta di applicare, se c'è */
  richiesta?: string
  /** esito scritto dal server dopo il riavvio */
  esito?: { quando: string; ok: boolean; messaggio: string }
  /** la richiesta aspetta da troppo: il servizio sul server non c'è (va rilanciato installa-server.sh) */
  servizioAssente: boolean
  /** l'ultima richiesta non ha ancora un esito (in attesa o "docker compose" ancora al lavoro) */
  inCorso: boolean
  /** l'ultima richiesta è senza esito da troppo: il riavvio si è bloccato o è finito senza scriverlo */
  senzaRisposta: boolean
}

/** Dopo quanto un'applicazione senza esito si considera bloccata. */
const ATTESA_MASSIMA_MS = 10 * 60_000

export class Impostazioni {
  private readonly fileEnv: string
  private readonly cartellaRichieste: string
  private readonly now: () => number

  constructor(fileEnv: string, cartellaRichieste: string, now: () => number = Date.now) {
    this.fileEnv = fileEnv
    this.cartellaRichieste = cartellaRichieste
    this.now = now
  }

  disponibile(): boolean {
    return existsSync(this.fileEnv)
  }

  private leggi(): Record<string, string> {
    return leggiEnv(readFileSync(this.fileEnv, 'utf8'))
  }

  /** Tutte le voci con i valori attuali; le password non si mandano, si dice solo se ci sono. */
  elenco(): VoceVista[] {
    const attuali = this.leggi()
    return VOCI.map(({ forma: _f, ...v }) => {
      const valore = valoreAttuale(attuali, v)
      return v.tipo === 'password' ? { ...v, valore: '', impostato: valore !== '' } : { ...v, valore }
    })
  }

  /**
   * Salva i valori cambiati. Le password lasciate vuote dal pannello restano quelle di prima, a meno
   * che non arrivi la richiesta esplicita di cancellarle (svuota). Restituisce le parti da riavviare.
   */
  salva(
    nuovi: Record<string, unknown>,
    opz: { avanzate: boolean; svuota?: string[] }
  ): { cambiate: string[]; parti: Parte[] } {
    const testo = readFileSync(this.fileEnv, 'utf8')
    const attuali = leggiEnv(testo)
    const valoreDi = (v: Voce): string => valoreAttuale(attuali, v)
    const svuota = new Set(opz.svuota ?? [])
    const cambi: Record<string, string> = {}
    for (const [k, grezzo] of Object.entries(nuovi)) {
      const voce = PER_CHIAVE.get(k)
      if (!voce) throw new Error(`impostazione sconosciuta: ${k}`)
      if (voce.tipo === 'password' && grezzo === '' && !svuota.has(k)) continue
      const v = controlla(voce, grezzo)
      if (v === valoreDi(voce)) continue
      if (voce.avanzato && !opz.avanzate) throw new Error(`${voce.etichetta}: si cambia solo con "Modifica avanzata"`)
      cambi[k] = v
    }
    for (const k of svuota) {
      const voce = PER_CHIAVE.get(k)
      if (!voce || voce.tipo !== 'password') throw new Error(`impostazione sconosciuta: ${k}`)
      if (!voce.vuoto) throw new Error(`${voce.etichetta}: non può restare vuoto`)
      if (voce.avanzato && !opz.avanzate && valoreDi(voce) !== '') throw new Error(`${voce.etichetta}: si cambia solo con "Modifica avanzata"`)
      if (valoreDi(voce) !== '') cambi[k] = ''
    }
    const cambiate = Object.keys(cambi)
    if (!cambiate.length) return { cambiate, parti: [] }
    const tutti: Record<string, string> = {}
    for (const v of VOCI) tutti[v.chiave] = cambi[v.chiave] ?? valoreDi(v)
    controllaInsieme(tutti)
    // scrittura sul posto (non con un file nuovo rinominato): il file è montato da solo nel contenitore
    writeFileSync(this.fileEnv, aggiornaEnv(testo, cambi))
    const parti = [...new Set(cambiate.flatMap((k) => PER_CHIAVE.get(k)!.parti))]
    return { cambiate, parti }
  }

  /**
   * Chiede al server di applicare il file .env (riavvio delle sole parti cambiate). Il servizio sul server
   * toglie subito il file "applica", prima di lanciare docker compose: l'ora della richiesta si tiene anche
   * in "ultima-richiesta", così fino all'esito nuovo il pannello sa che il lavoro è ancora in corso.
   */
  applica(): void {
    const quando = new Date(this.now()).toISOString() + '\n'
    writeFileSync(join(this.cartellaRichieste, 'ultima-richiesta'), quando)
    writeFileSync(join(this.cartellaRichieste, 'applica'), quando)
  }

  stato(): StatoApplica {
    const fileRichiesta = join(this.cartellaRichieste, 'applica')
    const fileEsito = join(this.cartellaRichieste, 'esito.json')
    const out: StatoApplica = { servizioAssente: false, inCorso: false, senzaRisposta: false }
    if (existsSync(fileRichiesta)) {
      out.richiesta = readFileSync(fileRichiesta, 'utf8').trim()
      // il servizio sul server la toglie subito: se è lì da più di un minuto, il servizio non c'è
      out.servizioAssente = this.now() - statSync(fileRichiesta).mtimeMs > 60_000
    }
    try {
      out.esito = JSON.parse(readFileSync(fileEsito, 'utf8'))
    } catch {
      // nessun esito ancora
    }
    let ultima = NaN
    try {
      ultima = Date.parse(readFileSync(join(this.cartellaRichieste, 'ultima-richiesta'), 'utf8').trim())
    } catch {
      // nessuna richiesta fatta da questa versione
    }
    const esitoQuando = out.esito ? Date.parse(out.esito.quando) : NaN
    // una richiesta ancora da prendere è sempre in corso, anche se c'è un esito più nuovo (di un riavvio
    // partito prima di questa richiesta)
    const senzaEsito = Number.isFinite(ultima) && !(esitoQuando >= ultima)
    out.inCorso = out.richiesta !== undefined || senzaEsito
    out.senzaRisposta = out.richiesta === undefined && senzaEsito && this.now() - ultima > ATTESA_MASSIMA_MS
    return out
  }

  /** Toglie una richiesta rimasta appesa (per riprovare). */
  annullaRichiesta(): void {
    try {
      unlinkSync(join(this.cartellaRichieste, 'applica'))
    } catch {
      // già tolta
    }
  }
}
