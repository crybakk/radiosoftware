/**
 * Servizio di controllo del ponte.
 *
 * Porta pubblica (CONTROLLO_PORTA, predefinita 9080), protetta da token:
 *   POST /api/heartbeat   segnali di vita e stato dalla regia
 *   POST /api/metadata    titolo/artista in onda → Liquidsoap → Icecast
 *   PUT  /api/backup      copia del database della regia
 *   GET  /api/backup      elenco copie;  GET /api/backup/<nome> scarica una copia
 *   GET  /api/stato       stato del ponte e allarmi attivi
 *   GET  /api/registro?da=<ISO>&a=<ISO>   brani suonati dal server (diretta autonoma, riserva, esterne riconosciute)
 *   GET/PUT/DELETE /api/impronte   impronte audio della libreria della regia (riconoscimento nelle esterne)
 *   GET  /api/caricati, GET /api/caricati/file?id=, POST /api/caricati/sposta   brani caricati dal pannello,
 *        che la regia scarica e cataloga
 *   POST /api/test-notifica  invia una notifica di prova
 *   GET  /health          senza token, per i controlli automatici
 *   WS   /ws/regia        canale in tempo reale con la regia (autenticazione col token nel primo messaggio)
 *
 * Pannello remoto (accesso con nome e password, sessione in un cookie):
 *   GET  /                pagine del pannello
 *   POST /api/login, POST /api/logout, GET /api/io
 *   GET/POST /api/utenti, DELETE /api/utenti/<nome>   (solo amministratori)
 *   WS   /ws/pannello     stato della regia e comandi, microfono, diretta autonoma, ospiti
 *   GET  /ospite.html?t=<link>, WS /ws/ospite?t=<link>   pagina e canale degli ospiti (link creato dal pannello)
 *   PUT  /api/autonoma/carica?nome=<file>   carica un brano nella libreria del server (conduttori)
 *   GET/PUT /api/video/logo   immagine delle dirette video su YouTube e Facebook (conduttori)
 *   GET/POST /api/sconosciuti, GET /api/sconosciuti/clip?id=   brani non riconosciuti nelle esterne (etichette)
 *
 * Statistiche degli ascoltatori: GET /api/ascoltatori?periodo=giorno|settimana&data=AAAA-MM-GG (pannello o token)
 * Titolo in onda come AzuraCast (senza accesso): GET /api/nowplaying, /api/nowplaying/<stazione>,
 *   /api/nowplaying_static/<stazione>.json, /api/station/<stazione>/playlist.m3u|pls, GET /api/logo
 * Programmi e puntate on demand: vedi programmiApi.ts (API pubbliche come quelle dei podcast di AzuraCast,
 *   pagine ascolta.html e podcast.html, gestione dal pannello, ultime puntate per le repliche della regia).
 *
 * Libreria del server copiata dalla regia (token): GET /api/libreria, PUT /api/libreria?id=regia/...,
 *   DELETE /api/libreria?id=regia/..., POST /api/libreria/dati (titoli e volumi corretti)
 *
 * Di solito davanti c'è Caddy, che fa l'HTTPS (porta 443). Senza Caddy, con CERTIFICATO_TLS e CHIAVE_TLS
 * la porta pubblica usa HTTPS da sola.
 * Porta interna 8091 (solo rete Docker): POST /internal/event da Liquidsoap, GET /internal/riserva
 * (brano a caso per la riserva del ponte).
 */
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { Alarms, DEFAULT_ALARM_CONFIG, type AlarmKey } from './alarms.ts'
import { Notifier } from './notifier.ts'
import { Relay } from './relay.ts'
import { can, ROLES, sameSecret, Users, type PublicUser, type Role } from './users.ts'
import { VoiceHub, voiceSockets, weriftFactory } from './voce.ts'
import { Guests } from './ospiti.ts'
import { AUDIO_EXT, Library } from './libreria.ts'
import { AutonomousPlayer } from './autonoma.ts'
import { VideoLive } from './video.ts'
import { PlayLog, type PlaySource } from './registro.ts'
import { FpStore, parseFpFile, UnknownStore, type UnknownLabel } from './riconoscimento.ts'
import { EsterneRecognition } from './esterne.ts'
import { LabelBot, type Section } from './telegram.ts'
import { AnnounceScheduler, AnnounceStore } from './annunciRadio.ts'
import { programContext, Synth } from './sintesi.ts'
import { activeSlot, Programs } from './programmi.ts'
import { apiNowPlaying, icecastListeners, NowPlaying } from './nowplaying.ts'
import { ListenerLog, period, readSecondary, report, type SecondaryConfig } from './ascoltatori.ts'
import { Recorder } from './puntate.ts'
import { handleProgramApi } from './programmiApi.ts'

const env = (k: string, d = ''): string => process.env[k] ?? d
const num = (k: string, d: number): number => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && process.env[k] !== '' ? v : d
}

const TOKEN = env('CONTROLLO_TOKEN')
const PUBLIC_PORT = num('CONTROLLO_PORTA', 9080)
const INTERNAL_PORT = num('CONTROLLO_PORTA_INTERNA', 8091)
const LIQUIDSOAP = env('LIQUIDSOAP_INTERNO', 'http://liquidsoap:8092')
const DATA_DIR = env('CARTELLA_DATI', '/data')
const BACKUP_DIR = join(DATA_DIR, 'backup')
const BACKUP_KEEP = num('BACKUP_DA_TENERE', 14)
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024
const CERT_FILE = env('CERTIFICATO_TLS')
const KEY_FILE = env('CHIAVE_TLS')
const LISTEN_URL = env('ASCOLTO_URL') || (env('DOMINIO') ? `https://${env('DOMINIO')}${env('ICECAST_MOUNT', '/radio.mp3')}` : '')
const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pannello')

if (TOKEN.length < 16) {
  console.error('CONTROLLO_TOKEN mancante o troppo corto (almeno 16 caratteri): il servizio non parte.')
  process.exit(1)
}

const notifier = new Notifier({
  telegramToken: env('TELEGRAM_BOT_TOKEN'),
  telegramChatId: env('TELEGRAM_CHAT_ID'),
  smtpHost: env('SMTP_HOST'),
  smtpPort: num('SMTP_PORTA', 587),
  smtpUser: env('SMTP_UTENTE'),
  smtpPassword: env('SMTP_PASSWORD'),
  smtpSecure: env('SMTP_SSL', 'no') === 'si',
  emailFrom: env('EMAIL_MITTENTE'),
  emailTo: env('EMAIL_DESTINATARI'),
  stationName: env('NOME_RADIO', 'Radio')
})

const alarms = new Alarms(
  {
    disconnectedSeconds: num('ALLARME_SCOLLEGATO_SECONDI', DEFAULT_ALARM_CONFIG.disconnectedSeconds),
    heartbeatSeconds: num('ALLARME_REGIA_MUTA_SECONDI', DEFAULT_ALARM_CONFIG.heartbeatSeconds),
    flapCount: num('ALLARME_RICONNESSIONI', DEFAULT_ALARM_CONFIG.flapCount)
  },
  (text: string, key: AlarmKey | 'esterna', open: boolean) => {
    console.log(`[allarme] ${open ? 'APERTO' : 'chiuso'} ${key}: ${text}`)
    void notifier.send(text)
    // il pannello vede gli allarmi aggiornati (dopo che la classe ha aggiornato il suo stato)
    queueMicrotask(() => relay.setAlarms(alarms.status().alarms))
  }
)
setInterval(() => alarms.tick(), 2000)

const relay = new Relay(TOKEN)
relay.onStudioChange = (c) => console.log(`[regia] canale di controllo ${c ? 'collegato' : 'scollegato'}`)
// segnale di vita a livello di applicazione: la regia capisce se il canale è ancora vivo
setInterval(() => relay.pingStudio(), 15_000)

await mkdir(DATA_DIR, { recursive: true })
let guests: Guests | null = null

// ---------- microfono remoto e ospiti (WebRTC) ----------

function portRange(v: string): [number, number] {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(v.trim())
  const a = m ? Number(m[1]) : 40000
  const b = m ? Number(m[2]) : 40049
  return a > 0 && b >= a && b < 65536 ? [a, b] : [40000, 40049]
}

// Posti audio in Liquidsoap: 0 = microfono del conduttore, 1-3 = ospiti.
// Voce verso Liquidsoap sulla porta 41030+2n, ritorno da Liquidsoap sulla 41040+2n (rete interna;
// porte pari perché RTP usa la successiva per RTCP).
const SLOT_NAMES = ['voce', 'ospite1', 'ospite2', 'ospite3']
const VOICE_HOST = env('VOCE_LIQUIDSOAP_HOST', 'liquidsoap')
const setVoiceOnAir = (slot: string, on: boolean): Promise<boolean> => lqPost('/voce', { slot, on })

if (env('MICROFONO_REMOTO', 'si') !== 'no') {
  const factory = weriftFactory({
    portRange: portRange(env('WEBRTC_PORTE', '40000-40049')),
    stun: env('WEBRTC_STUN', 'stun:stun.l.google.com:19302'),
    addresses: env('WEBRTC_INDIRIZZI')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  })
  const slots = SLOT_NAMES.map((name, n) => {
    const sockets = voiceSockets({ host: VOICE_HOST, port: 41030 + 2 * n }, 41040 + 2 * n, (pkt) => hub.sendReturn(pkt))
    const hub: VoiceHub = new VoiceHub({
      factory,
      sendVoice: (pkt) => sockets.sendVoice(pkt),
      setOnAir: (on) => setVoiceOnAir(name, on)
    })
    return hub
  })
  const voice = slots[0]
  voice.onChange = (m) => {
    console.log(`[microfono] ${m.user ? `${m.user}, ${m.onAir ? 'IN ONDA' : 'fuori onda'}` : 'chiuso'}`)
    relay.setMic(m)
  }
  relay.voice = voice
  guests = new Guests({
    file: join(DATA_DIR, 'inviti-ospiti.json'),
    slots: slots.slice(1),
    station: env('NOME_RADIO', 'Radio'),
    listenUrl: LISTEN_URL
  })
  guests.onChange = (list) => {
    console.log(`[ospiti] ${list.map((g) => `${g.name} (${g.state}${g.onAir ? ', IN ONDA' : ''})`).join(', ') || 'nessuno'}`)
    relay.setGuests(list)
  }
  relay.guests = guests
  // all'avvio tutte le voci sono chiuse: se Liquidsoap era rimasto con una voce aperta la togliamo
  setTimeout(() => SLOT_NAMES.forEach((n) => void setVoiceOnAir(n, false)), 3000)
}

const users = new Users(join(DATA_DIR, 'utenti.json'), join(DATA_DIR, 'sessioni.json'))
if (users.count() === 0) {
  const pw = env('PANNELLO_ADMIN_PASSWORD')
  if (pw.length >= 8) {
    users.save('admin', 'amministratore', pw)
    console.log('Creato l\'utente "admin" del pannello remoto')
  } else {
    console.log('Nessun utente del pannello: imposta PANNELLO_ADMIN_PASSWORD (almeno 8 caratteri) per creare "admin"')
  }
}

let lastStudio: Record<string, unknown> | null = null
let lastMetadata: { artist: string; title: string; at: string } | null = null

// ---------- diretta autonoma (musica dalla libreria del server) ----------

const MUSIC_DIR = env('CARTELLA_MUSICA', '/musica')
const UPLOAD_DIR = join(MUSIC_DIR, 'caricati')
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024
const library = new Library(MUSIC_DIR, join(DATA_DIR, 'libreria.json'))

async function lqPost(path: string, body: unknown = {}): Promise<boolean> {
  const r = await fetch(`${LIQUIDSOAP}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  }).catch(() => null)
  return !!r?.ok
}

const auto = new AutonomousPlayer(library, {
  setActive: (on) => lqPost('/autonoma', { on }),
  push: (uri) => lqPost('/autonoma/aggiungi', { uri }),
  skip: () => lqPost('/autonoma/salta')
})
auto.onChange = (st) => relay.setAuto(st)
auto.onActive = (on, by) => {
  alarms.setAutonomous(on)
  const text = on
    ? `📻 Diretta autonoma avviata${by ? ` da ${by}` : ''}: il ponte suona la libreria del server al posto della regia.`
    : `🏠 Diretta autonoma fermata${by ? ` da ${by}` : ''}.`
  console.log(`[autonoma] ${text}`)
  void notifier.send(text)
}
relay.auto = auto

// registro dei brani suonati dal server, per il report SIAE della regia
const playLog = new PlayLog(join(DATA_DIR, 'registro-server.jsonl'))
const logPlay = (source: PlaySource, file: string): void => {
  const t = library.byPath(file)
  if (!t) return console.log(`[registro] ${source}: brano non in libreria ${file}`)
  playLog.add({ source, id: t.id, title: t.title, artist: t.artist, duration: t.duration })
}
// titolo in onda per le app (formato AzuraCast): ogni brano del registro, più i metadati della regia
const nowPlaying = new NowPlaying()
playLog.onAdd = (e) => nowPlaying.set({ artist: e.artist, title: e.title, duration: e.duration, at: Date.parse(e.at), source: e.source })
let esternaSince: number | null = null
auto.onPlay = (t) => t.id.startsWith('.annunci/') || playLog.add({ source: 'autonoma', id: t.id, title: t.title, artist: t.artist, duration: t.duration })
// ---------- riconoscimento dei brani nelle dirette esterne ----------

const fpStore = new FpStore(join(DATA_DIR, 'impronte'))
const unknowns = new UnknownStore(join(DATA_DIR, 'sconosciuti'), fpStore.index)
let lastUnknownAlert = 0

/** Etichetta un brano sconosciuto (dal pannello o dal bot Telegram). */
function labelUnknown(id: string, label: UnknownLabel, by: string): void {
  const had = unknowns.get(id)?.label
  const u = unknowns.setLabel(id, label)
  // la prima volta: nel registro vanno tutti i passaggi già sentiti
  if (!had && u.label) {
    for (const at of u.heard) {
      playLog.add({ at, source: 'esterna', id: u.id, title: u.label.title, artist: u.label.artist, duration: u.seconds, composer: u.label.composer, publisher: u.label.publisher })
    }
  }
  console.log(`[riconoscimento] ${by} ha etichettato ${id}: ${u.label?.artist} - ${u.label?.title}`)
}
function discardUnknown(id: string, by: string): void {
  unknowns.discard(id)
  console.log(`[riconoscimento] ${by} ha scartato ${id}`)
}

/** Sezioni del menu del bot Telegram (solo lettura). */
function botSections(): Section[] {
  const n = (x: number): string => (Math.round(x * 10) / 10).toLocaleString('it-IT')
  const hm = (t: number | string): string => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
  return [
    {
      key: 'onda',
      label: '📻 In onda',
      render: async () => {
        const ls = (await fetch(`${LIQUIDSOAP}/stato`, { signal: AbortSignal.timeout(3000) })
          .then((r) => r.json())
          .catch(() => null)) as { studio?: boolean; esterna?: boolean; autonoma?: boolean; voce?: [string, boolean][] } | null
        const st = alarms.status()
        const lines: string[] = []
        if (!ls) lines.push('⚠️ Il mixer del ponte non risponde.')
        else if (ls.esterna) lines.push('📡 In onda: diretta esterna')
        else if (ls.autonoma) lines.push('🤖 In onda: diretta autonoma')
        else if (ls.studio) lines.push('🎚 In onda: regia dello studio')
        else lines.push('🆘 In onda: flusso di emergenza (musica casuale dalla libreria)')
        const voices = (ls?.voce ?? []).filter(([, on]) => on).map(([name]) => name)
        if (voices.length) lines.push(`🎙 Voci in onda dal pannello: ${voices.join(', ')}`)
        const cur = nowPlaying.current()
        if (cur) lines.push(`🎵 ${cur.artist ? `${cur.artist} - ` : ''}${cur.title} (dalle ${hm(cur.at)})`)
        lines.push(`Regia ${st.studioConnected ? 'collegata' : 'non collegata'} al ponte.`)
        if (st.alarms.length) lines.push('', '🚨 Allarmi attivi:', ...st.alarms.map((a) => `• ${a.message} (dalle ${hm(a.since)})`))
        else lines.push('Nessun allarme attivo.')
        return lines.join('\n')
      }
    },
    {
      key: 'ascoltatori',
      label: '🎧 Ascoltatori',
      render: () => {
        const now = listenerLog.latest()
        const lines: string[] = []
        if (now && Date.now() - now.t < 5 * 60_000) {
          lines.push(`🎧 Adesso: ${now.a + (now.b ?? 0)}${now.b === null ? '' : ` (${now.a} sul principale, ${now.b} sul secondario)`}`)
        } else lines.push('🎧 Adesso: non disponibile')
        for (const kind of ['giorno', 'settimana'] as const) {
          const p = period(kind, '')
          const r = report(listenerLog.read(p.from, p.to), p.from, p.to, p.step, programs.list())
          const peakAt = r.peakAt ? ` alle ${kind === 'giorno' ? hm(r.peakAt) : new Date(r.peakAt).toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''
          lines.push('', kind === 'giorno' ? 'Oggi:' : 'Questa settimana:', `picco ${r.peak}${peakAt}, media ${n(r.avg)}, ${n(r.hours)} ore di ascolto`)
        }
        return lines.join('\n')
      }
    },
    {
      key: 'puntate',
      label: '🎙 Puntate',
      render: () => {
        const titles = new Map(programs.list().map((p) => [p.id, p.title]))
        const eps = programs.episodes()
        const rec = eps.filter((e) => e.status === 'registrazione')
        const drafts = eps.filter((e) => e.status === 'bozza')
        const lines: string[] = []
        if (rec.length) lines.push('🔴 In registrazione:', ...rec.map((e) => `• ${titles.get(e.programId) ?? e.programId} (dalle ${hm(e.recordedFrom)})`), '')
        if (drafts.length) {
          lines.push('📝 Bozze da pubblicare (dal pannello):')
          for (const e of drafts.slice(-15)) lines.push(`• ${titles.get(e.programId) ?? e.programId}: ${e.title} (${Math.round(e.length / 60)} min)`)
        } else lines.push('Nessuna puntata da pubblicare.')
        return lines.join('\n')
      }
    }
  ]
}

// bot Telegram per etichettare (diverso da quello degli allarmi)
let labelBot: LabelBot | null = null
if (env('TELEGRAM_ETICHETTE_TOKEN') && env('TELEGRAM_ETICHETTE_CHAT_ID')) {
  labelBot = new LabelBot({
    token: env('TELEGRAM_ETICHETTE_TOKEN'),
    chatId: env('TELEGRAM_ETICHETTE_CHAT_ID'),
    stateFile: join(DATA_DIR, 'telegram-etichette.json'),
    stationName: env('NOME_RADIO', 'Radio'),
    get: (id) => unknowns.get(id),
    pending: () => unknowns.list().filter((u) => !u.label),
    labelled: () => unknowns.list().filter((u) => u.label),
    sections: botSections(),
    clipFile: (id) => unknowns.clipFile(id),
    label: labelUnknown,
    discard: discardUnknown
  })
  labelBot.start()
}

const esterne = new EsterneRecognition({
  fp: fpStore,
  unknowns,
  playLog,
  url: env('RICONOSCIMENTO_AUDIO_URL', 'http://liquidsoap:8093/programma'),
  onUnknown: (n, u) => {
    // con il bot delle etichette arriva subito l'audio da etichettare
    if (labelBot) {
      labelBot.sendUnknown(u).catch((e: unknown) => console.error(`[telegram] invio non riuscito: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    // altrimenti un avviso ogni tanto, non a ogni brano
    if (Date.now() - lastUnknownAlert < 30 * 60_000) return
    lastUnknownAlert = Date.now()
    void notifier.send(`🎵 Diretta esterna: ${n} ${n === 1 ? 'brano sconosciuto' : 'brani sconosciuti'} da etichettare nel pannello (Brani sconosciuti).`)
  }
})
const riconoscimentoAttivo = env('RICONOSCIMENTO', 'si') !== 'no'
// se il controllo riparte durante un'esterna, si riprende l'ascolto
setTimeout(() => {
  if (!riconoscimentoAttivo) return
  void fetch(`${LIQUIDSOAP}/stato`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json() as Promise<{ esterna?: boolean }>)
    .then((st) => esterne.setActive(!!st.esterna))
    .catch(() => {})
}, 4000)

// all'avvio la diretta autonoma è ferma: se Liquidsoap era rimasto acceso la spegniamo
setTimeout(() => void lqPost('/autonoma', { on: false }), 3000)
const rescan = (): void =>
  void library
    .scan()
    .then((n) => {
      console.log(`[autonoma] libreria del server: ${n} brani`)
      relay.setAuto(auto.state())
    })
    .catch((e: unknown) => console.error(`[autonoma] scansione: ${e instanceof Error ? e.message : String(e)}`))
rescan()
setInterval(rescan, 30 * 60_000)

// ---------- programmi e puntate on demand ----------

const programs = new Programs(join(DATA_DIR, 'programmi'))

// ---------- annunci con la voce sintetica (solo quando trasmette il server) ----------

// gli MP3 vanno nella cartella della musica (la vede anche Liquidsoap), in una sottocartella nascosta
// che la libreria non legge; le voci scaricate stanno con i dati
const synth = new Synth({ voicesDir: join(DATA_DIR, 'voci'), outDir: join(MUSIC_DIR, '.annunci'), ffmpeg: 'ffmpeg' })
const announceStore = new AnnounceStore(join(DATA_DIR, 'annunci.json'))
/** true se adesso va in onda il server: diretta autonoma, oppure riserva (né regia né esterna). */
async function serverOnAir(): Promise<boolean> {
  if (auto.state().active) return true
  const ls = (await fetch(`${LIQUIDSOAP}/stato`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json())) as { studio?: boolean; esterna?: boolean; autonoma?: boolean }
  return !ls.studio && !ls.esterna && !ls.autonoma
}
function announceContext() {
  const a = auto.state()
  const cur = nowPlaying.current()
  const next = a.active ? (a.prepared ?? a.queue[0] ?? null) : null
  return {
    track: cur ? { title: cur.title, artist: cur.artist } : null,
    nextTrack: next && next.artist !== 'Annuncio vocale' ? { title: next.title, artist: next.artist } : null,
    ...programContext(programs.list(), new Date())
  }
}
const announcer = new AnnounceScheduler({
  store: announceStore,
  speak: (text, voice) => synth.speak(text, voice),
  onAir: serverOnAir,
  context: announceContext,
  stationName: env('NOME_RADIO', 'Radio'),
  folder: '.annunci'
})
auto.interject = () => announcer.take()
announcer.start()
let recorder: Recorder | null = null
if (env('REGISTRAZIONE_PUNTATE', 'si') !== 'no') {
  recorder = new Recorder({
    programs,
    url: env('PUNTATE_AUDIO_URL', 'http://liquidsoap:8093/programma'),
    bitrate: env('PUNTATE_BITRATE', '128k'),
    onDraft: (e) => {
      const p = programs.get(e.programId)
      void notifier.send(`🎙️ Nuova puntata registrata di "${p?.title ?? e.programId}": da rivedere e pubblicare dal pannello (Programmi e puntate).`)
    }
  })
  recorder.start()
}

// ---------- titolo in onda come AzuraCast ----------

const ICECAST_INTERNO = env('ICECAST_INTERNO', 'http://icecast:8000')
const MOUNT = env('ICECAST_MOUNT', '/radio.mp3')
let icecastCache = { at: 0, listeners: 0, online: true, reachable: false }
async function icecastStatus(fresh = false): Promise<{ listeners: number; online: boolean; reachable: boolean }> {
  if (!fresh && Date.now() - icecastCache.at < 15_000) return icecastCache
  const st = await fetch(`${ICECAST_INTERNO}/status-json.xsl`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json())
    .catch(() => null)
  // Icecast non raggiungibile: si dice "in onda" (il ponte manda sempre qualcosa) e 0 ascoltatori
  icecastCache = { at: Date.now(), reachable: !!st, ...(st ? icecastListeners(st, MOUNT) : { listeners: 0, online: true }) }
  return icecastCache
}

// ---------- statistiche degli ascoltatori (ogni minuto, storico di un anno) ----------

const listenerLog = new ListenerLog(join(DATA_DIR, 'ascoltatori'))
const secondaryIcecast: SecondaryConfig = {
  host: env('ICECAST_ESTERNO_HOST'),
  port: num('ICECAST_ESTERNO_PORTA', 8000),
  mount: env('ICECAST_ESTERNO_MOUNT', '/radio.mp3'),
  adminUser: env('ICECAST_ESTERNO_ADMIN_UTENTE', 'admin'),
  adminPassword: env('ICECAST_ESTERNO_ADMIN_PASSWORD')
}
let secondaryWarned = false
async function sampleListeners(): Promise<void> {
  const ice = await icecastStatus(true)
  // senza l'Icecast principale non si scrive nulla: meglio un buco che uno zero falso
  if (!ice.reachable) return
  const b = await readSecondary(secondaryIcecast)
  if (secondaryIcecast.host && b === null && !secondaryWarned) {
    secondaryWarned = true
    console.log('[ascoltatori] Icecast secondario non leggibile: pagina status-json.xsl chiusa? Imposta ICECAST_ESTERNO_ADMIN_PASSWORD')
  }
  listenerLog.add({ t: Date.now(), a: ice.listeners, b })
}
setInterval(() => void sampleListeners().catch(() => {}), 60_000)
setTimeout(() => void sampleListeners().catch(() => {}), 10_000)
listenerLog.prune()
setInterval(() => listenerLog.prune(), 24 * 3600_000)

function listenerReport(url: URL): Record<string, unknown> {
  const kind = url.searchParams.get('periodo') === 'settimana' ? 'settimana' : 'giorno'
  const p = period(kind, url.searchParams.get('data') ?? '')
  return {
    now: listenerLog.latest(),
    secondary: !!secondaryIcecast.host,
    periodo: kind,
    ...report(listenerLog.read(p.from, p.to), p.from, p.to, p.step, programs.list())
  }
}

async function handleNowPlaying(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname
  const st = programs.settings().station
  const isStation = (s: string): boolean => s === st || s === '1'
  const m = /^\/api\/(?:nowplaying(?:\/([^/]+))?|nowplaying_static\/([^/]+)\.json|station\/([^/]+)\/playlist\.(m3u|pls)|logo)$/.exec(p)
  if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return false
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }
  if (p === '/api/logo') {
    const f = logoFile()
    if (!f) return json(res, 404, { error: 'nessun logo' }), true
    res.writeHead(200, { ...cors, 'Content-Type': f.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'public, max-age=600' })
    pipeline(createReadStream(f), res).catch(() => res.destroy())
    return true
  }
  if (m[3]) {
    if (!isStation(m[3])) return json(res, 404, { error: 'stazione non trovata' }), true
    const name = env('NOME_RADIO', 'Radio')
    const body = m[4] === 'm3u' ? `#EXTM3U\n#EXTINF:-1,${name}\n${LISTEN_URL}\n` : `[playlist]\nFile1=${LISTEN_URL}\nTitle1=${name}\nLength1=-1\nNumberOfEntries=1\nVersion=2\n`
    res.writeHead(200, { ...cors, 'Content-Type': m[4] === 'm3u' ? 'audio/x-mpegurl' : 'audio/x-scpls', 'Content-Disposition': `attachment; filename="${st}.${m[4]}"` })
    res.end(body)
    return true
  }
  const which = m[1] ?? m[2]
  if (which !== undefined && !isStation(which)) return json(res, 404, { error: 'stazione non trovata' }, cors), true
  const base = `${tls || viaHttps(req) ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`
  const ice = await icecastStatus()
  const now = Date.now()
  const prog = programs.list().find((x) => activeSlot(x.slots, new Date(now)))
  const progArt = prog?.art ? `${base}/api/station/${st}/public/podcast/${prog.id}/art-${prog.artUpdatedAt}.jpg` : ''
  const data = apiNowPlaying(nowPlaying, {
    base,
    station: st,
    name: env('NOME_RADIO', 'Radio'),
    description: env('DESCRIZIONE_RADIO'),
    listenUrl: LISTEN_URL,
    mount: MOUNT,
    bitrate: num('ICECAST_BITRATE', 128),
    listeners: ice.listeners,
    online: ice.online,
    live: { isLive: esternaSince !== null, streamer: esternaSince !== null ? (prog?.title ?? 'Diretta esterna') : '', since: esternaSince },
    art: progArt || (logoFile() ? `${base}/api/logo` : ''),
    now
  })
  json(res, 200, p === '/api/nowplaying' ? [data] : data, cors)
  return true
}

// ---------- dirette video (YouTube, Facebook) ----------

const LOGO_FILES = { png: join(DATA_DIR, 'logo-video.png'), jpg: join(DATA_DIR, 'logo-video.jpg') }
const MAX_LOGO_BYTES = 5 * 1024 * 1024
const logoFile = (): string | null => (existsSync(LOGO_FILES.png) ? LOGO_FILES.png : existsSync(LOGO_FILES.jpg) ? LOGO_FILES.jpg : null)
let video: VideoLive | null = null
if (env('DIRETTE_VIDEO', 'si') !== 'no') {
  video = new VideoLive({
    file: join(DATA_DIR, 'dirette-video.json'),
    logo: logoFile,
    audioUrl: env('VIDEO_AUDIO_URL', 'http://liquidsoap:8093/programma'),
    obsPort: num('VIDEO_OBS_PORTA', 9020),
    obsPassphrase: env('VIDEO_OBS_PASSPHRASE')
  })
  const v = video
  let last = ''
  v.onChange = (st) => {
    const line = `${st.state}${st.error ? `: ${st.error}` : ''}`
    if (line !== last) console.log(`[video] ${line}`)
    last = line
    relay.setVideo(st)
  }
  v.onAlert = (text) => void notifier.send(text)
  v.onLog = (line) => console.log(`[video] ffmpeg: ${line}`)
  relay.video = v
  relay.setVideo(v.status())
}

async function saveLogo(req: IncomingMessage): Promise<void> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length
    if (size > MAX_LOGO_BYTES) throw new Error('immagine troppo grande (massimo 5 MB)')
    chunks.push(c)
  }
  const data = Buffer.concat(chunks)
  const kind = data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    ? 'png'
    : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      ? 'jpg'
      : null
  if (!kind) throw new Error("l'immagine deve essere PNG o JPEG")
  const file = LOGO_FILES[kind]
  await writeFile(`${file}.tmp`, data)
  await rename(`${file}.tmp`, file)
  await rm(kind === 'png' ? LOGO_FILES.jpg : LOGO_FILES.png, { force: true })
}

/** Nome di file sicuro per i brani caricati dal pannello. */
function safeName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? ''
  const ext = extname(base).toLowerCase()
  if (!AUDIO_EXT.has(ext)) return null
  const stem = base
    .slice(0, -ext.length)
    .replace(/[^\p{L}\p{N} ._()&'-]/gu, '_')
    .trim()
    .slice(0, 150)
  return stem ? `${stem}${ext}` : null
}

/** Percorso nella libreria per un brano della regia: "regia/<cartella>/<...>/<file>", senza "..". */
function studioPath(id: string): string | null {
  const parts = id.split('/')
  if (parts[0] !== 'regia' || parts.length < 2) return null
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || /[\\\0]/.test(p))) return null
  if (!AUDIO_EXT.has(extname(id).toLowerCase())) return null
  return join(MUSIC_DIR, ...parts)
}

async function saveUpload(req: IncomingMessage, file: string): Promise<string> {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${file.slice(dir.length + 1)}.part`)
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > MAX_UPLOAD_BYTES) req.destroy(new Error('file troppo grande (massimo 300 MB)'))
  })
  try {
    await pipeline(req, createWriteStream(tmp))
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  await rename(tmp, file)
  return file
}

// ---------- utilità HTTP ----------

/** Con Caddy davanti (PROXY_FIDATO=si) l'indirizzo vero del browser è l'ultimo di X-Forwarded-For. */
const TRUST_PROXY = env('PROXY_FIDATO', 'no') === 'si'
function clientIp(req: IncomingMessage): string {
  const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() : ''
  return fwd || req.socket.remoteAddress || ''
}
function viaHttps(req: IncomingMessage): boolean {
  return TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https'
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...extra })
  res.end(data)
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error('richiesta troppo grande')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const text = (await readBody(req, limit)).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

function authorized(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? ''
  const m = /^Bearer (.+)$/.exec(h)
  if (!m) return false
  return sameSecret(m[1], TOKEN)
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k !== name) continue
    try {
      return decodeURIComponent(v.join('='))
    } catch {
      return undefined // codifica non valida: come se il cookie non ci fosse
    }
  }
  return undefined
}

function sessionUser(req: IncomingMessage): PublicUser | null {
  return users.session(cookie(req, 'sessione'))
}

/** Le connessioni dal browser devono arrivare dalla pagina del pannello stesso. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

// troppi tentativi di accesso sbagliati dallo stesso indirizzo: pausa di un minuto
// (il tentativo si conta prima di leggere la richiesta, e si toglie se l'accesso riesce:
//  così tante richieste in parallelo non passano tutte il controllo)
const failedLogins = new Map<string, number[]>()
function recentAttempts(ip: string): number[] {
  const now = Date.now()
  const list = (failedLogins.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (list.length) failedLogins.set(ip, list)
  else failedLogins.delete(ip)
  return list
}
/** Riserva un tentativo; restituisce null se ce ne sono già troppi, altrimenti la funzione per annullarlo. */
function reserveAttempt(ip: string): (() => void) | null {
  const list = recentAttempts(ip)
  if (list.length >= 5) return null
  const t = Date.now()
  list.push(t)
  failedLogins.set(ip, list)
  return () => {
    const l = failedLogins.get(ip)
    const i = l ? l.indexOf(t) : -1
    if (i >= 0) l!.splice(i, 1)
    if (l && !l.length) failedLogins.delete(ip)
  }
}
// pulizia degli indirizzi che non tentano più
setInterval(() => {
  for (const ip of [...failedLogins.keys()]) recentAttempts(ip)
}, 60_000)

// WebSocket dei pannelli aperti con ogni sessione: all'uscita si chiudono
const panelSockets = new Map<string, Set<WebSocket>>()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
}

async function serveStatic(res: ServerResponse, path: string): Promise<boolean> {
  const name = path === '/' ? 'index.html' : path.slice(1)
  if (!/^[\w.-]+$/.test(name)) return false
  const file = join(PANEL_DIR, name)
  const data = await readFile(file).catch(() => null)
  if (!data) return false
  res.writeHead(200, {
    'Content-Type': MIME[extname(name)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    // media-src https: per l'ascolto della radio nella sala d'attesa degli ospiti
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob: https: http:; frame-ancestors 'none'"
  })
  res.end(data)
  return true
}

// ---------- backup ----------

async function listBackups(): Promise<{ name: string; size: number; date: string }[]> {
  await mkdir(BACKUP_DIR, { recursive: true })
  const names = (await readdir(BACKUP_DIR)).filter((n) => /^radio-[\dT-]+\.db$/.test(n)).sort().reverse()
  const out = []
  for (const name of names) {
    const st = await stat(join(BACKUP_DIR, name))
    out.push({ name, size: st.size, date: st.mtime.toISOString() })
  }
  return out
}

async function saveBackup(req: IncomingMessage): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `radio-${stamp}.db`
  // nome provvisorio unico: due invii nello stesso secondo non si mescolano
  const tmp = join(BACKUP_DIR, `.${name}.${randomBytes(6).toString('hex')}.part`)
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > MAX_BACKUP_BYTES) req.destroy(new Error('backup troppo grande'))
  })
  try {
    await pipeline(req, createWriteStream(tmp))
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  if (size < 100) {
    await rm(tmp, { force: true })
    throw new Error('backup vuoto')
  }
  await rename(tmp, join(BACKUP_DIR, name))
  const all = await listBackups()
  for (const old of all.slice(BACKUP_KEEP)) await rm(join(BACKUP_DIR, old.name), { force: true })
  return name
}

// ---------- server pubblico ----------

function loadCert(): { cert: Buffer; key: Buffer } | null {
  if (!CERT_FILE || !KEY_FILE || !existsSync(CERT_FILE) || !existsSync(KEY_FILE)) return null
  try {
    return { cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) }
  } catch (e) {
    // per esempio permessi del file: meglio partire in HTTP che non partire
    console.error(`Certificato non leggibile, uso HTTP: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
const certs = loadCert()
const tls = certs !== null

async function handlePublic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/health') return json(res, 200, { ok: true })
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (await serveStatic(res, url.pathname)) return
      return json(res, 404, { error: 'non trovato' })
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'non trovato' })

    // --- statistiche degli ascoltatori (pannello con accesso, regia con il token) ---
    if (req.method === 'GET' && url.pathname === '/api/ascoltatori') {
      if (!sessionUser(req) && !authorized(req)) return json(res, 401, { error: 'accesso richiesto' })
      return json(res, 200, listenerReport(url))
    }

    // --- titolo in onda e ascolto (pubblici, come AzuraCast) ---
    if (await handleNowPlaying(req, res, url)) return

    // --- programmi e puntate (pubbliche, pannello, regia) ---
    if (
      await handleProgramApi(req, res, url, {
        programs,
        recorder,
        stationName: env('NOME_RADIO', 'Radio'),
        listenUrl: LISTEN_URL,
        nowPlaying: () => {
          const a = auto.state()
          if (a.active && a.onAir) return { artist: a.onAir.artist, title: a.onAir.title }
          return lastMetadata ? { artist: lastMetadata.artist, title: lastMetadata.title } : null
        },
        user: sessionUser,
        sameOrigin,
        authorized,
        base: (r) => `${tls || viaHttps(r) ? 'https' : 'http'}://${r.headers.host ?? 'localhost'}`
      })
    )
      return

    // --- annunci con la voce sintetica (pannello, amministratori) ---
    if (url.pathname.startsWith('/api/annunci')) {
      const me = sessionUser(req)
      if (!me) return json(res, 401, { error: 'accesso richiesto' })
      if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'origine non valida' })
      if (req.method === 'GET' && url.pathname === '/api/annunci') {
        return json(res, 200, { ...announceStore.get(), stationName: env('NOME_RADIO', 'Radio'), voices: synth.voices(), waiting: announcer.waiting() })
      }
      if (req.method === 'GET' && url.pathname === '/api/annunci/audio') {
        // solo i file prodotti dalla voce, per ascoltare la prova
        const f = url.searchParams.get('f') ?? ''
        if (!/^annuncio-[0-9a-f]+\.mp3$/.test(f)) return json(res, 400, { error: 'file non valido' })
        const file = join(MUSIC_DIR, '.annunci', f)
        if (!existsSync(file)) return json(res, 404, { error: 'non trovato' })
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String((await stat(file)).size), 'Cache-Control': 'no-store' })
        return void createReadStream(file).pipe(res)
      }
      if (!can(me.role, 'utenti')) return json(res, 403, { error: 'solo gli amministratori possono cambiare gli annunci' })
      const body = await readJson(req)
      if (req.method === 'POST' && url.pathname === '/api/annunci') {
        const cfg = await announceStore.save(body as never)
        console.log(`[annunci] ${me.name} ha salvato ${cfg.items.length} annunci`)
        return json(res, 200, { ...cfg, stationName: env('NOME_RADIO', 'Radio'), voices: synth.voices(), waiting: announcer.waiting() })
      }
      if (req.method === 'POST' && url.pathname === '/api/annunci/voce') {
        const id = String(body.id ?? '')
        const action = body.remove ? synth.removeVoice(id) : synth.installVoice(id)
        // lo scaricamento può durare minuti: si risponde subito e il pannello ricontrolla
        if (!body.remove) {
          action.catch((e: unknown) => console.error(`[annunci] voce non scaricata: ${e instanceof Error ? e.message : String(e)}`))
          await new Promise((r) => setTimeout(r, 300))
        } else await action
        return json(res, 200, { voices: synth.voices() })
      }
      if (req.method === 'POST' && url.pathname === '/api/annunci/prova') {
        const f = announcer.fill(String(body.text ?? ''), typeof body.radio === 'string' ? body.radio : undefined)
        if (!f.text.replace(/[\s.,;:!?]/g, '')) return json(res, 400, { error: 'testo vuoto' })
        const r = await synth.speak(f.text, (body.voice ?? announceStore.get().voice) as never)
        return json(res, 200, { text: f.text, missing: f.missing, seconds: r.seconds, url: `/api/annunci/audio?f=${encodeURIComponent(r.file.split(/[\\/]/).at(-1)!)}` })
      }
      return json(res, 404, { error: 'non trovato' })
    }

    // --- pannello remoto (sessione) ---
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'origine non valida' })
      const ip = clientIp(req)
      const cancel = reserveAttempt(ip)
      if (!cancel) return json(res, 429, { error: 'Troppi tentativi: riprova tra un minuto' })
      const body = await readJson(req, 4096)
      const s = await users.login(String(body.name ?? '').trim(), String(body.password ?? ''))
      if (!s) return json(res, 401, { error: 'Nome o password errati' })
      cancel()
      res.setHeader(
        'Set-Cookie',
        `sessione=${s.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}${tls || viaHttps(req) ? '; Secure' : ''}`
      )
      return json(res, 200, { user: s.user })
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const t = cookie(req, 'sessione')
      if (t) {
        users.logout(t)
        for (const ws of panelSockets.get(t) ?? []) ws.close(4003, 'sessione chiusa')
        panelSockets.delete(t)
      }
      res.setHeader('Set-Cookie', 'sessione=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
      return json(res, 200, { ok: true })
    }
    if (req.method === 'PUT' && url.pathname === '/api/autonoma/carica') {
      const me = sessionUser(req)
      if (!me) return json(res, 401, { error: 'accesso richiesto' })
      if (!can(me.role, 'comandare')) return json(res, 403, { error: 'il tuo ruolo non permette di caricare brani' })
      if (!sameOrigin(req)) return json(res, 403, { error: 'origine non valida' })
      const name = safeName(url.searchParams.get('nome') ?? '')
      if (!name) return json(res, 400, { error: 'formato non supportato (mp3, m4a, aac, flac, ogg, opus, wav)' })
      const file = await saveUpload(req, join(UPLOAD_DIR, name))
      const t = await library.addFile(file)
      library.save()
      relay.setAuto(auto.state())
      console.log(`[autonoma] ${me.name} ha caricato ${t.id}`)
      return json(res, 200, { track: { id: t.id, title: t.title, artist: t.artist, duration: t.duration } })
    }
    if (url.pathname === '/api/video/logo') {
      const me = sessionUser(req)
      if (!me) return json(res, 401, { error: 'accesso richiesto' })
      if (req.method === 'GET') {
        const f = logoFile()
        if (!f) return json(res, 404, { error: 'nessun logo' })
        res.writeHead(200, { 'Content-Type': f.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' })
        return await pipeline(createReadStream(f), res)
      }
      if (req.method === 'PUT') {
        if (!can(me.role, 'comandare')) return json(res, 403, { error: 'il tuo ruolo non permette di cambiare il logo' })
        if (!sameOrigin(req)) return json(res, 403, { error: 'origine non valida' })
        await saveLogo(req)
        video?.logoChanged()
        console.log(`[video] ${me.name} ha caricato il logo`)
        return json(res, 200, { ok: true })
      }
    }
    if (url.pathname === '/api/sconosciuti' || url.pathname === '/api/sconosciuti/clip') {
      const me = sessionUser(req)
      if (!me) return json(res, 401, { error: 'accesso richiesto' })
      if (req.method === 'GET' && url.pathname === '/api/sconosciuti') {
        return json(res, 200, { items: unknowns.list(), attivo: esterne.isActive(), ultimo: esterne.last })
      }
      if (req.method === 'GET') {
        const f = unknowns.clipFile(url.searchParams.get('id') ?? '')
        const st = f ? await stat(f).catch(() => null) : null
        if (!f || !st) return json(res, 404, { error: 'audio non trovato' })
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': st.size, 'Cache-Control': 'no-store' })
        return await pipeline(createReadStream(f), res)
      }
      if (req.method === 'POST') {
        if (!can(me.role, 'comandare')) return json(res, 403, { error: 'il tuo ruolo non permette di etichettare i brani' })
        if (!sameOrigin(req)) return json(res, 403, { error: 'origine non valida' })
        const body = await readJson(req, 8192)
        const id = String(body.id ?? '')
        if (body.azione === 'scarta') {
          discardUnknown(id, me.name)
          return json(res, 200, { items: unknowns.list() })
        }
        labelUnknown(
          id,
          { title: String(body.title ?? ''), artist: String(body.artist ?? ''), composer: String(body.composer ?? ''), publisher: String(body.publisher ?? '') },
          me.name
        )
        return json(res, 200, { items: unknowns.list() })
      }
      return json(res, 404, { error: 'non trovato' })
    }
    if (url.pathname === '/api/io' || url.pathname.startsWith('/api/utenti')) {
      const me = sessionUser(req)
      if (!me) return json(res, 401, { error: 'accesso richiesto' })
      if (url.pathname === '/api/io') return json(res, 200, { user: me })
      if (!can(me.role, 'utenti')) return json(res, 403, { error: 'solo gli amministratori gestiscono gli utenti' })
      if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'origine non valida' })
      if (req.method === 'GET' && url.pathname === '/api/utenti') return json(res, 200, { users: users.list(), roles: ROLES })
      if (req.method === 'POST' && url.pathname === '/api/utenti') {
        const body = await readJson(req, 4096)
        const name = String(body.name ?? '').trim()
        const password = body.password ? String(body.password) : undefined
        const before = users.get(name)
        const u = users.save(name, String(body.role ?? '') as Role, password)
        if (password) relay.kick(u.name)
        // cambio di ruolo: il pannello si ricollega e riceve il ruolo nuovo
        else if (before && before.role !== u.role) relay.kick(u.name, 4002, 'ruolo cambiato')
        return json(res, 200, { user: u, users: users.list() })
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/utenti/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/utenti/'.length))
        if (name.toLowerCase() === me.name.toLowerCase()) return json(res, 400, { error: 'non puoi eliminare te stesso' })
        users.remove(name)
        relay.kick(name)
        return json(res, 200, { users: users.list() })
      }
      return json(res, 404, { error: 'non trovato' })
    }

    // --- regia (token) ---
    if (!authorized(req)) return json(res, 401, { error: 'token non valido' })

    if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
      lastStudio = { ...(await readJson(req)), receivedAt: new Date().toISOString() }
      alarms.onHeartbeat()
      relay.setAlarms(alarms.status().alarms)
      return json(res, 200, { ok: true, alarms: alarms.status().alarms })
    }
    if (req.method === 'POST' && url.pathname === '/api/metadata') {
      const body = await readJson(req)
      const artist = String(body.artist ?? '').slice(0, 300)
      const title = String(body.title ?? '').slice(0, 300)
      lastMetadata = { artist, title, at: new Date().toISOString() }
      nowPlaying.set({ artist, title, duration: Number(body.duration) || 0, at: Date.now(), source: 'regia' })
      const r = await fetch(`${LIQUIDSOAP}/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artist, title }),
        signal: AbortSignal.timeout(5000)
      }).catch(() => null)
      return json(res, r?.ok ? 200 : 502, { ok: !!r?.ok })
    }
    if (req.method === 'PUT' && url.pathname === '/api/backup') {
      const name = await saveBackup(req)
      return json(res, 200, { ok: true, name })
    }
    if (req.method === 'GET' && url.pathname === '/api/backup') return json(res, 200, await listBackups())
    if (req.method === 'GET' && url.pathname.startsWith('/api/backup/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/backup/'.length))
      if (!/^radio-[\dT-]+\.db$/.test(name)) return json(res, 400, { error: 'nome non valido' })
      const file = join(BACKUP_DIR, name)
      const st = await stat(file).catch(() => null)
      if (!st) return json(res, 404, { error: 'backup non trovato' })
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${name}"`
      })
      // se la lettura si interrompe la risposta viene chiusa (vedi sotto)
      return await pipeline(createReadStream(file), res)
    }
    if (url.pathname === '/api/libreria' || url.pathname === '/api/libreria/dati') {
      if (req.method === 'GET') {
        // prima si guarda la cartella: ci possono essere file copiati a mano (disco USB)
        await Promise.race([library.scan().catch(() => 0), new Promise((r) => setTimeout(r, 45_000))])
        if (library.isScanning()) return json(res, 503, { error: 'il server sta ancora leggendo la libreria: riprova più tardi' })
        return json(res, 200, library.all().filter((t) => t.id.startsWith('regia/')).map((t) => ({ id: t.id, size: t.size })))
      }
      if (req.method === 'POST' && url.pathname === '/api/libreria/dati') {
        const body = await readJson(req, 16 * 1024 * 1024)
        const list = Array.isArray(body.tracks) ? (body.tracks as Record<string, unknown>[]) : []
        let n = 0
        for (const m of list) {
          if (library.setMeta(String(m.id), { title: String(m.title ?? ''), artist: String(m.artist ?? ''), duration: Number(m.duration), gainDb: Number(m.gainDb) })) n++
        }
        library.save()
        return json(res, 200, { ok: true, updated: n })
      }
      const id = url.searchParams.get('id') ?? ''
      const file = studioPath(id)
      if (!file) return json(res, 400, { error: 'percorso non valido' })
      if (req.method === 'PUT') {
        await saveUpload(req, file)
        const q = url.searchParams
        const t = await library.addFile(file, {
          title: q.get('titolo') ?? undefined,
          artist: q.get('artista') ?? undefined,
          duration: Number(q.get('durata')),
          gainDb: Number(q.get('guadagno'))
        })
        library.save()
        return json(res, 200, { ok: true, id: t.id, size: t.size })
      }
      if (req.method === 'DELETE') {
        await rm(file, { force: true })
        library.remove(id)
        library.save()
        return json(res, 200, { ok: true })
      }
    }
    if (url.pathname === '/api/impronte') {
      if (req.method === 'GET') return json(res, 200, fpStore.list())
      if (req.method === 'PUT') {
        // più impronte in un corpo solo: [lunghezza u32][file impronta] ...
        const body = await readBody(req, 64 * 1024 * 1024)
        let o = 0
        let n = 0
        while (o + 4 <= body.length) {
          const len = body.readUInt32LE(o)
          o += 4
          if (len > 4 * 1024 * 1024 || o + len > body.length) return json(res, 400, { error: 'impronte non valide' })
          const { meta, fp } = parseFpFile(body.subarray(o, o + len))
          o += len
          if (!/^regia\//.test(meta.id)) return json(res, 400, { error: `percorso non valido: ${meta.id}` })
          fpStore.put(meta, fp)
          n++
        }
        return json(res, 200, { ok: true, saved: n })
      }
      if (req.method === 'DELETE') {
        const body = await readJson(req, 16 * 1024 * 1024)
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
        for (const id of ids) fpStore.remove(id)
        return json(res, 200, { ok: true, removed: ids.length })
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/caricati') {
      return json(res, 200, library.all().filter((t) => t.id.startsWith('caricati/')).map((t) => ({ id: t.id, size: t.size, title: t.title, artist: t.artist, duration: t.duration })))
    }
    if (req.method === 'GET' && url.pathname === '/api/caricati/file') {
      const t = library.get(url.searchParams.get('id') ?? '')
      if (!t || !t.id.startsWith('caricati/')) return json(res, 404, { error: 'brano non trovato' })
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': t.size })
      return await pipeline(createReadStream(library.path(t)), res)
    }
    if (req.method === 'POST' && url.pathname === '/api/caricati/sposta') {
      // la regia l'ha scaricato e catalogato: il file prende il percorso che avrà dalla regia, così non si ricarica
      const body = await readJson(req)
      const t = library.get(String(body.da ?? ''))
      const dest = studioPath(String(body.a ?? ''))
      if (!t || !t.id.startsWith('caricati/')) return json(res, 404, { error: 'brano non trovato' })
      if (!dest) return json(res, 400, { error: 'percorso non valido' })
      await mkdir(dirname(dest), { recursive: true })
      await rename(library.path(t), dest)
      library.remove(t.id)
      const moved = await library.addFile(dest, { title: t.title, artist: t.artist, duration: t.duration, gainDb: t.gainDb })
      library.save()
      relay.setAuto(auto.state())
      console.log(`[libreria] ${t.id} spostato in ${moved.id} (catalogato dalla regia)`)
      return json(res, 200, { ok: true, id: moved.id, size: moved.size })
    }
    if (req.method === 'GET' && url.pathname === '/api/registro') {
      if (!authorized(req)) return json(res, 401, { error: 'token non valido' })
      const from = new Date(url.searchParams.get('da') ?? '')
      const to = new Date(url.searchParams.get('a') ?? '')
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return json(res, 400, { error: 'date non valide' })
      return json(res, 200, playLog.list(from, to))
    }
    if (req.method === 'GET' && url.pathname === '/api/stato') {
      const ls = await fetch(`${LIQUIDSOAP}/stato`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json())
        .catch(() => null)
      return json(res, 200, {
        ...alarms.status(),
        liquidsoap: ls,
        studio: lastStudio,
        metadata: lastMetadata,
        notifiche: notifier.channels()
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/test-notifica') {
      const results = await notifier.send('🔔 Notifica di prova dal ponte di Radio Regia.')
      return json(res, 200, { ok: results.every((r) => r.ok), results })
    }
    return json(res, 404, { error: 'non trovato' })
  } catch (e) {
    // risposta già iniziata (per esempio un backup in download): non si può che chiuderla
    if (res.headersSent) return void res.destroy()
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) })
  }
}

const onRequest = (req: IncomingMessage, res: ServerResponse): void =>
  void handlePublic(req, res).catch(() => res.destroy())
const publicServer = certs ? createHttpsServer(certs, onRequest) : createServer(onRequest)

if (tls) {
  // il certificato può essere rinnovato da fuori: lo ricarichiamo ogni 12 ore
  setInterval(() => {
    const c = loadCert()
    if (c) (publicServer as ReturnType<typeof createHttpsServer>).setSecureContext(c)
  }, 12 * 3600_000)
}

// ---------- WebSocket: regia e pannelli ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

/** `valid` (facoltativo) si ricontrolla a ogni segnale di vita: se diventa falso la connessione si chiude. */
function wire(ws: WebSocket, h: { message: (raw: string) => void; close: () => void }, valid?: () => boolean): void {
  // un messaggio malformato non deve mai far cadere il servizio
  ws.on('message', (data) => {
    try {
      h.message(String(data))
    } catch (e) {
      console.error(`[ws] messaggio scartato: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  ws.on('close', () => {
    try {
      h.close()
    } catch (e) {
      console.error(`[ws] errore in chiusura: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  ws.on('error', () => ws.terminate())
  // segnale di vita: le connessioni morte (4G caduto) vengono chiuse
  let alive = true
  ws.on('pong', () => (alive = true))
  const ping = setInterval(() => {
    if (!alive) return ws.terminate()
    if (valid && !valid()) return ws.close(4003, 'sessione scaduta')
    alive = false
    ws.ping()
  }, 15_000)
  ws.on('close', () => clearInterval(ping))
}

publicServer.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy())
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/ws/regia') {
      return wss.handleUpgrade(req, socket, head, (ws) => wire(ws, relay.attachStudio(ws)))
    }
    if (url.pathname === '/ws/pannello') {
      const token = cookie(req, 'sessione')
      const me = users.session(token)
      if (!token || !me || !sameOrigin(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return socket.destroy()
      }
      const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
      return wss.handleUpgrade(req, socket, head, (ws) => {
        const set = panelSockets.get(token) ?? new Set<WebSocket>()
        panelSockets.set(token, set)
        set.add(ws)
        ws.on('close', () => {
          set.delete(ws)
          if (!set.size && panelSockets.get(token) === set) panelSockets.delete(token)
        })
        // a ogni comando si usa il ruolo attuale della sessione (cambiato, scaduta, utente eliminato)
        const current = (): PublicUser | null => users.session(token)
        wire(ws, relay.attachPanel(ws, me, host || undefined, current), () => current() !== null)
      })
    }
    if (url.pathname === '/ws/ospite') {
      const invite = guests?.validInvite(url.searchParams.get('t'))
      if (!guests || !invite || !sameOrigin(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        return socket.destroy()
      }
      const g = guests
      const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
      return wss.handleUpgrade(req, socket, head, (ws) => wire(ws, g.attach(ws, invite, host || undefined)))
    }
    socket.destroy()
  } catch (e) {
    console.error(`[ws] richiesta di collegamento non valida: ${e instanceof Error ? e.message : String(e)}`)
    socket.destroy()
  }
})

// ---------- server interno (Liquidsoap) ----------

const internalServer = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/internal/riserva') {
      const uri = auto.nextReserve()
      res.writeHead(uri ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return void res.end(uri ?? '')
    }
    if (req.method === 'POST' && req.url === '/internal/event') {
      const body = await readJson(req)
      const kind = String(body.kind ?? '')
      console.log(`[evento] ${kind} ${body.detail ?? ''}`)
      if (kind === 'autonoma_brano') auto.onTrackStart(String(body.detail ?? ''))
      else if (kind === 'riserva_brano') logPlay('riserva', String(body.detail ?? ''))
      else {
        if (riconoscimentoAttivo && kind === 'esterna_collegata') esterne.setActive(true)
        if (kind === 'esterna_scollegata') esterne.setActive(false)
        if (kind === 'esterna_collegata') esternaSince = Date.now()
        if (kind === 'esterna_scollegata') esternaSince = null
        alarms.onEvent(kind, String(body.detail ?? ''))
      }
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'non trovato' })
  } catch (e) {
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) })
  }
})

publicServer.listen(PUBLIC_PORT, () => console.log(`Controllo in ascolto sulla porta ${PUBLIC_PORT}${tls ? ' (HTTPS)' : ''}`))
internalServer.listen(INTERNAL_PORT, () => console.log(`Eventi interni sulla porta ${INTERNAL_PORT}`))

const shutdown = async (): Promise<void> => {
  video?.stop()
  labelBot?.stop()
  announcer.stop()
  await recorder?.stop().catch(() => {})
  publicServer.close()
  internalServer.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
