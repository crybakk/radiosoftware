/**
 * Radio Esterna: app per Mac e Windows per andare in onda da fuori (scelte di cristian, 24/11/2026).
 * Mixer di microfoni e audio del computer, IN ONDA / FUORI ONDA, titolo del programma, registrazione
 * (sul computer e sul server), ritorno dello studio in cuffia e pannello della regia in una scheda.
 */
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, session, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { controllaAttivazione } from '../../../src/main/attivazione.ts'
import { RegistrazioneProgrammi, type RecorderLike, type StatoRegistrazioneProgrammi } from '../../../src/core/registrazioneProgrammi.ts'
import { Aggiornamenti } from './aggiornamenti'
import { accedi, Collegamento, normalizzaServer } from './collegamento'
import { Registratore } from './registratore'
import { ServerHttp } from './server'
import { mixerPredefinito, pulisciMixer } from '../shared/mixer'
import type { Impostazioni, ImpostazioniMixer, StatoRegistrazioneLocale } from '../shared/api'

const NOME = 'Radio Esterna'
const GUIDA = 'https://github.com/crybakk/radiosoftware/blob/main/docs/GUIDA.md#3-fare-una-diretta-esterna'

// audio del computer sul Mac (macOS 13 o più recente): cattura del sistema con ScreenCaptureKit
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride')
}
// l'audio continua anche con la finestra in secondo piano o ridotta a icona
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

function ffmpegPath(): string {
  const p = ffmpegStatic as unknown as string | null
  return p ? p.replace('app.asar', 'app.asar.unpacked') : 'ffmpeg'
}

// ---------- impostazioni (con il token della sessione cifrato) ----------

interface Salvate {
  server: string
  utente: string
  /** Token cifrato con safeStorage (base64), o in chiaro se il sistema non cifra. */
  token: string
  tokenCifrato: boolean
  mixer: ImpostazioniMixer
  programId: string | null
  testo: string
  cartellaRegistrazioni: string
  testoGrande: boolean
  mostraAvanzate: boolean
}

const fileImpostazioni = (): string => join(app.getPath('userData'), 'impostazioni.json')
let salvate: Salvate

function carica(): Salvate {
  const base: Salvate = {
    server: '',
    utente: '',
    token: '',
    tokenCifrato: false,
    mixer: mixerPredefinito(),
    programId: null,
    testo: '',
    cartellaRegistrazioni: join(app.getPath('documents'), NOME),
    testoGrande: false,
    mostraAvanzate: false
  }
  try {
    const s = JSON.parse(readFileSync(fileImpostazioni(), 'utf8')) as Partial<Salvate>
    return { ...base, ...s, mixer: pulisciMixer(s.mixer), testoGrande: s.testoGrande === true, mostraAvanzate: s.mostraAvanzate === true }
  } catch {
    return base
  }
}

function salva(): void {
  try {
    writeFileSync(`${fileImpostazioni()}.tmp`, JSON.stringify(salvate, null, 1))
    renameSync(`${fileImpostazioni()}.tmp`, fileImpostazioni())
  } catch (e) {
    console.error(`impostazioni non salvate: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function leggiToken(): string {
  if (!salvate.token) return ''
  try {
    return salvate.tokenCifrato ? safeStorage.decryptString(Buffer.from(salvate.token, 'base64')) : salvate.token
  } catch {
    return ''
  }
}

function scriviToken(t: string): void {
  if (t && safeStorage.isEncryptionAvailable()) {
    salvate.token = safeStorage.encryptString(t).toString('base64')
    salvate.tokenCifrato = true
  } else {
    salvate.token = t
    salvate.tokenCifrato = false
  }
}

function pubbliche(): Impostazioni {
  return {
    server: salvate.server,
    utente: salvate.utente,
    accesso: !!leggiToken(),
    mixer: salvate.mixer,
    programId: salvate.programId,
    testo: salvate.testo,
    cartellaRegistrazioni: salvate.cartellaRegistrazioni,
    testoGrande: salvate.testoGrande,
    mostraAvanzate: salvate.mostraAvanzate
  }
}

// ---------- finestra ----------

let win: BrowserWindow | null = null
const manda = (canale: string, ...a: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(canale, ...a)
}
/** Solo la finestra dell'app può chiamare il processo principale (non il pannello nella scheda Regia). */
const dallApp = (e: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame

/** Testo grande: tutta la finestra un quarto più grande (come la regia). */
const zoom = (): void => {
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(salvate?.testoGrande ? 1.25 : 1)
}

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  if (!(await controllaAttivazione(app.getPath('userData'), NOME))) {
    app.quit()
    return
  }
  salvate = carica()

  let eraCollegato = false
  const collegamento = new Collegamento({
    riavviaInvio: () => manda('riavvia-invio'),
    onRtc: (m) => manda('rtc', m),
    onStato: (s) => {
      manda('stato', s)
      // appena collegati si rilegge l'elenco dei programmi (per le puntate)
      const ora = s.collegamento === 'collegato'
      if (ora && !eraCollegato) void registrazioni.aggiornaProgrammi().catch(() => {})
      eraCollegato = ora
    },
    versione: app.getVersion()
  })

  const http = (): ServerHttp | null => {
    const t = leggiToken()
    return salvate.server && t ? new ServerHttp(salvate.server, t) : null
  }

  // ---------- registrazioni ----------
  const registratore = new Registratore({ ffmpeg: ffmpegPath(), pezzi: (on) => manda('pezzi', on), log: (s) => console.log(`[registrazione] ${s}`) })
  /** "solo sul computer" o puntata del programma */
  let modo: 'puntata' | 'locale' | null = null
  let ultimoLocale: string | null = null

  const recorder: RecorderLike = {
    start: (title, programId) => {
      registratore.avvia(join(app.getPath('userData'), 'registrazioni'), title)
      modo = 'puntata'
      // anche il server registra il programma: se il collegamento non cade, si tiene la sua (niente invio sul 4G)
      if (programId) void http()?.inizio(programId).catch(() => {})
      return null
    },
    stop: async () => {
      const r = await registratore.ferma()
      modo = null
      return r ? { file: r.file, startedAt: new Date(r.inizio).toISOString(), endedAt: new Date(r.fine).toISOString() } : null
    },
    status: () => {
      const s = registratore.stato()
      return { active: s.attiva && modo === 'puntata', bytes: s.byte, problem: s.problema }
    }
  }
  const registrazioni = new RegistrazioneProgrammi({
    recorder,
    server: () => {
      const h = http()
      return h ? { fine: (f) => h.fine(f), upload: (f, body) => h.invia(f, body) } : null
    },
    programs: async () => {
      const h = http()
      if (!h) throw new Error('non collegato')
      return h.programmiPerRegistrare()
    },
    stateFile: join(app.getPath('userData'), 'registrazioni.json'),
    // l'invio del file non deve togliere banda alla diretta: al massimo 3 Mbit/s
    maxKbps: 3000
  })
  registrazioni.onStatus((s) => manda('registrazione', s))
  registrazioni.start()

  const statoLocale = (): StatoRegistrazioneLocale => {
    const s = registratore.stato()
    return { attiva: s.attiva && modo === 'locale', file: modo === 'locale' ? s.file : null, inizio: modo === 'locale' ? s.inizio : null, byte: modo === 'locale' ? s.byte : 0, problema: modo === 'locale' ? s.problema : null, ultimo: ultimoLocale }
  }
  setInterval(() => {
    if (modo === 'locale') manda('locale', statoLocale())
  }, 2000)

  // segni automatici della puntata: il primo IN ONDA è l'inizio, l'ultimo FUORI ONDA la fine
  let ultimoFuoriOnda: number | null = null

  // ---------- aggiornamenti ----------
  const aggiornamenti = new Aggiornamenti((s) => manda('aggiornamento', s))
  aggiornamenti.avvia()

  // ---------- sessione e pannello nella scheda Regia ----------
  async function impostaCookie(): Promise<void> {
    const t = leggiToken()
    if (!salvate.server || !t) return
    await session.defaultSession.cookies
      .set({ url: salvate.server, name: 'sessione', value: t, httpOnly: true, secure: salvate.server.startsWith('https:'), sameSite: 'strict', expirationDate: Date.now() / 1000 + 30 * 86400 })
      .catch(() => {})
  }
  async function collega(): Promise<void> {
    const t = leggiToken()
    if (!salvate.server || !t) return collegamento.ferma()
    await impostaCookie()
    collegamento.setMeta(salvate.programId, salvate.testo)
    collegamento.avvia(salvate.server, t)
  }

  // ---------- audio del computer (cattura dello schermo con l'audio di sistema) ----------
  session.defaultSession.setDisplayMediaRequestHandler(
    (_req, cb) => {
      void desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => cb(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => cb({}))
    },
    { useSystemPicker: false }
  )
  // microfoni e audio del computer solo per la finestra dell'app; il pannello nella scheda Regia non li usa
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
    const dallaFinestra = !!win && wc === win.webContents
    cb(dallaFinestra && (perm === 'media' || perm === 'display-capture' || perm === 'speaker-selection'))
  })
  session.defaultSession.setPermissionCheckHandler((wc, perm) => {
    const dallaFinestra = !!win && wc === win.webContents
    return dallaFinestra && (perm === 'media' || perm === 'display-capture' || perm === 'speaker-selection')
  })

  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: NOME,
    backgroundColor: '#111418',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false
    }
  })
  win.webContents.on('did-finish-load', zoom)
  // la scheda Regia può aprire solo il pannello del server, senza accessi al computer
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete (prefs as { preload?: string }).preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    let ok = false
    try {
      ok = !!salvate.server && new URL(params.src).origin === new URL(salvate.server).origin
    } catch {
      ok = false
    }
    if (!ok) e.preventDefault()
  })
  win.webContents.on('did-attach-webview', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      // la guida e il player del pannello si aprono nel browser
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  // chiudere mentre si è in onda o si registra: si chiede conferma
  let chiudiComunque = false
  win.on('close', (e) => {
    const inOnda = collegamento.stato().esterna?.inOnda
    if (chiudiComunque || (!inOnda && !registratore.attivo())) return
    e.preventDefault()
    const scelta = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Annulla', 'Chiudi comunque'],
      defaultId: 0,
      cancelId: 0,
      title: NOME,
      message: inOnda ? 'Sei ancora in onda.' : 'Stai registrando.',
      detail: inOnda ? 'Se chiudi, la radio torna alla regia (o alla musica di riserva) tra qualche secondo.' : 'Se chiudi, la registrazione si ferma qui.'
    })
    if (scelta === 1) {
      chiudiComunque = true
      if (inOnda) {
        try {
          collegamento.onda(false)
        } catch {
          // già scollegati
        }
      }
      void registrazioni
        .chiudi()
        .catch(() => {})
        .finally(() => setTimeout(() => win?.close(), 500))
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  // ---------- comandi dalla finestra ----------
  const handle = (canale: string, fn: (...a: never[]) => unknown): void => {
    ipcMain.handle(canale, (e, ...a) => {
      if (!dallApp(e)) throw new Error('non permesso')
      return (fn as (...x: unknown[]) => unknown)(...a)
    })
  }
  handle('impostazioni', () => pubbliche())
  handle('salvaMixer', (m: ImpostazioniMixer) => {
    salvate.mixer = pulisciMixer(m)
    salva()
  })
  handle('accedi', async (server: string, utente: string, password: string) => {
    const base = normalizzaServer(server)
    const r = await accedi(base, utente.trim(), password)
    salvate.server = base
    salvate.utente = r.nome
    scriviToken(r.token)
    salva()
    await collega()
    return pubbliche()
  })
  handle('esci', async () => {
    collegamento.ferma()
    const h = http()
    // la sessione si chiude anche sul server
    if (h && salvate.server) {
      await fetch(`${salvate.server}/api/logout`, { method: 'POST', headers: { Cookie: `sessione=${leggiToken()}` }, signal: AbortSignal.timeout(5000) }).catch(() => {})
    }
    scriviToken('')
    salva()
    await session.defaultSession.cookies.remove(salvate.server, 'sessione').catch(() => {})
    return pubbliche()
  })
  handle('aspetto', (a: { testoGrande?: unknown; mostraAvanzate?: unknown }) => {
    if (typeof a?.testoGrande === 'boolean') salvate.testoGrande = a.testoGrande
    if (typeof a?.mostraAvanzate === 'boolean') salvate.mostraAvanzate = a.mostraAvanzate
    salva()
    zoom()
    return pubbliche()
  })
  handle('stato', () => collegamento.stato())
  handle('programmi', async () => {
    const h = http()
    return h ? h.programmi() : []
  })
  handle('meta', (programId: string | null, testo: string) => {
    salvate.programId = programId
    salvate.testo = String(testo ?? '').slice(0, 200)
    salva()
    collegamento.setMeta(salvate.programId, salvate.testo)
  })
  handle('onda', (on: boolean) => {
    collegamento.onda(on === true)
    const reg = registrazioni.status().corrente
    if (on && reg && reg.startMark === null) registrazioni.registra()
    if (!on) ultimoFuoriOnda = Date.now()
  })
  ipcMain.on('rtc-offerta', (e, sdp: string) => {
    if (!dallApp(e) || typeof sdp !== 'string' || sdp.length > 20_000) return
    collegamento.rtcOfferta(sdp)
  })
  ipcMain.on('rtc-chiudi', (e) => {
    if (dallApp(e)) collegamento.rtcChiudi()
  })
  ipcMain.on('audio', (e, pezzo: ArrayBuffer, inizio: boolean) => {
    if (!dallApp(e)) return
    collegamento.audio(Buffer.from(pezzo), inizio === true)
  })
  ipcMain.on('pezzo-registrazione', (e, pezzo: ArrayBuffer) => {
    if (!dallApp(e)) return
    registratore.pezzo(Buffer.from(pezzo))
  })
  handle('registrazione', () => registrazioni.status())
  handle('registra', async (programId: string) => {
    if (modo === 'locale') throw new Error('Prima ferma la registrazione solo sul computer.')
    // programma appena creato nel pannello (o elenco non ancora letto): si rilegge
    if (!registrazioni.status().programmi.some((p) => p.id === programId)) await registrazioni.aggiornaProgrammi()
    ultimoFuoriOnda = null
    const s = registrazioni.registra(programId)
    // se sei già in onda, l'inizio è adesso
    if (collegamento.stato().esterna?.inOnda && s.corrente && s.corrente.startMark === null) return registrazioni.registra()
    return s
  })
  handle('segnaInizio', () => registrazioni.registra())
  handle('fineProgramma', (): Promise<StatoRegistrazioneProgrammi> => {
    const inOnda = collegamento.stato().esterna?.inOnda
    // fuori onda: la puntata finisce all'ultimo FUORI ONDA
    return registrazioni.fine(!inOnda && ultimoFuoriOnda !== null ? ultimoFuoriOnda : undefined)
  })
  handle('registraLocale', async (on: boolean) => {
    if (on) {
      if (registratore.attivo()) throw new Error('c\'è già una registrazione in corso')
      const titolo = salvate.testo || 'Diretta esterna'
      registratore.avvia(salvate.cartellaRegistrazioni, titolo)
      modo = 'locale'
    } else if (modo === 'locale') {
      const r = await registratore.ferma()
      modo = null
      ultimoLocale = r?.file ?? null
    }
    const s = statoLocale()
    manda('locale', s)
    return s
  })
  handle('statoLocale', () => statoLocale())
  handle('apriCartella', async () => {
    if (!existsSync(salvate.cartellaRegistrazioni)) return
    await shell.openPath(salvate.cartellaRegistrazioni)
  })
  handle('scegliCartella', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath: salvate.cartellaRegistrazioni })
    if (!r.canceled && r.filePaths[0]) {
      salvate.cartellaRegistrazioni = r.filePaths[0]
      salva()
    }
    return pubbliche()
  })
  handle('permessoMicrofono', async () => {
    if (process.platform !== 'darwin') return true
    return systemPreferences.askForMediaAccess('microphone')
  })
  handle('aggiornamento', () => aggiornamenti.get())
  handle('controllaAggiornamenti', () => aggiornamenti.controlla())
  handle('installaAggiornamento', () => aggiornamenti.installa())
  handle('versione', () => app.getVersion())
  handle('apriGuida', () => shell.openExternal(GUIDA))

  // sessione salvata: si ricollega da sola (se è scaduta, il collegamento lo dice e si rientra)
  void collega()
})

app.on('window-all-closed', () => app.quit())
