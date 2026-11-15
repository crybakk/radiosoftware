import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { spawn } from 'node:child_process'
import { expandEvent } from '../core/eventActions'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { logToCsv } from '../core/csv'
import { quarterRange, siaeCsv, siaeRows } from '../core/siae'
import { syncServerPlays } from '../core/serverPlays'
import { MusicBrainzService } from './musicbrainz'
import { RadioDb, type TrackEdit, type TrackSearch } from '../core/db'
import { RotationService } from '../core/rotationService'
import type { ScheduledEvent, Settings, Track, TrackKind } from '../core/types'
import { LibraryService } from './library'
import { serveFile } from './media'
import { applyPendingRestore, PonteService, type StudioReport } from './ponte'
import { ServerLibrarySync } from './serverSync'
import type { RemoteCommand, RemoteState } from '../core/remote'

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
])

// Cartella dati alternativa (prove, installazione portatile)
if (process.env.RADIO_DATA_DIR) app.setPath('userData', process.env.RADIO_DATA_DIR)

// Un'unica istanza: due regie aperte sullo stesso database sarebbero un disastro in onda.
if (!app.requestSingleInstanceLock()) app.quit()

function ffmpegPath(): string | null {
  const p = ffmpegStatic as unknown as string | null
  return p ? p.replace('app.asar', 'app.asar.unpacked') : null
}

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Radio Regia',
    backgroundColor: '#111418',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      // la messa in onda non deve rallentare quando la finestra è ridotta a icona
      backgroundThrottling: false
    }
  })
  win.maximize()
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  let restoredFrom: string | null = null
  try {
    restoredFrom = applyPendingRestore(app.getPath('userData'))
  } catch (e) {
    dialog.showErrorBox('Ripristino non riuscito', e instanceof Error ? e.message : String(e))
  }
  const db = new RadioDb(join(app.getPath('userData'), 'radio.db'))
  db.closeDanglingLog(new Date())
  const library = new LibraryService(db, ffmpegPath())
  const rotation = new RotationService(db)
  const ponte = new PonteService(db, app.getPath('userData'), ffmpegPath())
  ponte.applySettings(db.getSettings().ponte)
  const serverSync = new ServerLibrarySync(db, app.getPath('userData'), () => ponte.client(), (st) =>
    win?.webContents.send('serverSyncStatus', st)
  )
  const mb = new MusicBrainzService(db, (st) => win?.webContents.send('mbStatus', st))
  // brani caricati dal pannello e scaricati in regia: analisi, impronta e MusicBrainz da soli
  serverSync.onCatalogued = (ids) => {
    void library.analyzeAll()
    void mb.lookup(ids)
  }

  // brani suonati dal server (diretta autonoma, riserva) → registro di trasmissione
  let serverPlaysError: string | null = null
  const importServerPlays = async (): Promise<number> => {
    const c = ponte.client()
    if (!c) {
      serverPlaysError = 'ponte non configurato'
      return 0
    }
    try {
      const n = await syncServerPlays(db, c)
      serverPlaysError = null
      return n
    } catch (e) {
      serverPlaysError = e instanceof Error ? e.message : String(e)
      return 0
    }
  }
  const siaeReport = async (year: number, q: number) => {
    await importServerPlays()
    const [from, to] = quarterRange(year, q)
    const entries = db.listLog(from, to)
    const ids = [...new Set(entries.map((e) => e.trackId).filter((id): id is number => id != null))]
    const tracks = new Map(db.getTracks(ids).map((t) => [t.id, t]))
    return { rows: siaeRows(entries, tracks), serverError: serverPlaysError }
  }

  // ogni 10 minuti: nelle ore scelte invia al server i brani nuovi della selezione,
  // e scarica i brani suonati dal server
  const syncTimer = setInterval(() => {
    void serverSync.tick()
    void importServerPlays()
  }, 10 * 60_000)
  void importServerPlays()

  protocol.handle('media', async (request) => {
    const url = new URL(request.url)
    if (url.host === 'stream') {
      // flusso esterno: lo inoltriamo noi, così il browser non ha problemi di CORS
      const target = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!/^https?:\/\//i.test(target)) return new Response('Indirizzo non valido', { status: 400 })
      try {
        const upstream = await net.fetch(target, { headers: { 'Icy-MetaData': '0' } })
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('content-type') ?? 'audio/mpeg',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
          }
        })
      } catch {
        return new Response('Flusso non raggiungibile', { status: 502 })
      }
    }
    const id = Number(new URL(request.url).pathname.replace(/^\//, ''))
    const track = Number.isFinite(id) ? db.getTrack(id) : null
    if (!track) return new Response('Brano non trovato', { status: 404 })
    const res = serveFile(track.path, request)
    res.headers.set('Access-Control-Allow-Origin', '*')
    return res
  })

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void => {
    ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)))
  }

  // libreria
  handle('listFolders', () => db.listFolders())
  handle('chooseAndAddFolder', async (kind: TrackKind) => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Scegli una cartella della libreria',
      properties: ['openDirectory', 'multiSelections']
    })
    if (!res.canceled) for (const p of res.filePaths) db.addFolder(p, kind)
    return db.listFolders()
  })
  handle('removeFolder', (id: number) => {
    db.removeFolder(id)
    return db.listFolders()
  })
  handle('scan', () => {
    void library.scan()
  })
  handle('libraryStatus', () => library.status())
  handle('search', (q: TrackSearch) => db.searchTracks(q))
  handle('getTrack', (id: number) => db.getTrack(id))
  handle('getTracks', (ids: number[]) => db.getTracks(ids))
  handle('updateTrack', (id: number, edit: TrackEdit) => db.updateTrack(id, edit))

  // impostazioni
  handle('getSettings', () => db.getSettings())
  handle('saveSettings', (patch: Partial<Settings>) => {
    const s = db.saveSettings(patch)
    if (patch.ponte) ponte.applySettings(s.ponte)
    return s
  })

  // eventi
  handle('listEvents', () => db.listEvents())
  handle('saveEvent', (e: Omit<ScheduledEvent, 'id'> & { id?: number }) => {
    db.saveEvent(e)
    return db.listEvents()
  })
  handle('deleteEvent', (id: number) => {
    db.deleteEvent(id)
    return db.listEvents()
  })

  // rotazione e registro
  handle('fillQueue', (upcoming: { trackId: number; at: string }[], count: number) => {
    const tracks = new Map(db.getTracks(upcoming.map((u) => u.trackId)).map((t) => [t.id, t]))
    const planned = upcoming
      .filter((u) => tracks.has(u.trackId))
      .map((u) => ({ track: tracks.get(u.trackId)!, at: new Date(u.at) }))
    return rotation.fill(planned, count)
  })
  handle('logStart', (track: Track, at: string) => {
    // per i brani della libreria usiamo i dati aggiornati del database (autori, codici SIAE)
    const t = track.id > 0 ? (db.getTrack(track.id) ?? track) : track
    ponte.onTrackStart(t)
    return db.logStart(t, new Date(at), track.id > 0 ? 'regia' : 'flusso esterno')
  })
  handle('expandEvent', (event: ScheduledEvent) =>
    expandEvent(db, event, {
      now: () => new Date(),
      runCommand: (command) => {
        const child = spawn(command, { shell: true, detached: true, windowsHide: true, stdio: 'ignore' })
        child.on('error', () => {})
        child.unref()
      }
    })
  )
  handle('listGenres', () => db.listGenres())
  handle('choosePath', async (kind: 'playlist' | 'folder') => {
    const res = await dialog.showOpenDialog(win!, {
      title: kind === 'folder' ? 'Scegli una cartella' : 'Scegli una playlist',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
      filters: kind === 'folder' ? undefined : [{ name: 'Playlist', extensions: ['m3u', 'm3u8', 'pls'] }]
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('logEnd', (logId: number, at: string, seconds: number) => {
    if (logId > 0) db.logEnd(logId, new Date(at), seconds)
  })
  handle('listLog', (from: string, to: string) => db.listLog(new Date(from), new Date(to)))
  handle('exportLogCsv', async (from: string, to: string) => {
    const entries = db.listLog(new Date(from), new Date(to))
    const res = await dialog.showSaveDialog(win!, {
      title: 'Esporta registro di trasmissione',
      defaultPath: `registro_${from.slice(0, 10)}_${to.slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, logToCsv(entries), 'utf8')
    return res.filePath
  })

  // report SIAE e completamento dati
  handle('siaeReport', (year: number, q: number) => siaeReport(year, q))
  handle('exportSiaeCsv', async (year: number, q: number) => {
    const { rows } = await siaeReport(year, q)
    const res = await dialog.showSaveDialog(win!, {
      title: 'Salva il report SIAE',
      defaultPath: `SIAE_${year}_T${q}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, siaeCsv(rows), 'utf8')
    return res.filePath
  })
  handle('incompleteMusic', () => db.incompleteMusic())
  handle('mbStatus', () => mb.status())
  handle('mbStart', () => {
    void mb.start()
  })
  handle('mbStop', () => mb.stop())
  handle('mbRetry', () => mb.retry())

  // ponte
  handle('ponteStatus', () => ponte.getStatus())
  handle('ponteCapture', (active: boolean, sampleRate: number) => ponte.setCapture(active, sampleRate))
  handle('ponteReport', (r: StudioReport) => ponte.setReport(r))
  handle('ponteBackupNow', () => ponte.backupNow())
  handle('ponteListBackups', () => ponte.listBackups())
  handle('ponteState', () => ponte.remoteState())
  handle('ponteTestNotification', () => ponte.testNotification())
  handle('ponteRestore', async (name: string) => {
    await ponte.prepareRestore(name)
    app.relaunch()
    app.quit()
  })
  handle('restoredFrom', () => restoredFrom)

  // libreria del server (diretta autonoma)
  handle('serverSyncStatus', () => serverSync.status())
  handle('serverSyncList', (filter: 'esclusi' | 'tutti', q: string) => serverSync.list(filter, q))
  handle('serverSyncChoice', (id: number, choice: boolean | null) => serverSync.setChoice(id, choice))
  handle('serverSyncNow', () => serverSync.syncNow(true))
  handle('serverSyncStop', () => serverSync.stop())
  handle('serverSyncExport', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Scegli il disco o la cartella dove copiare la selezione',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    return serverSync.exportTo(res.filePaths[0])
  })
  ipcMain.on('uplink:pcm', (_e, pcm: Uint8Array) => ponte.writePcm(pcm))
  ipcMain.on('remote:state', (_e, state: RemoteState) => ponte.sendRemoteState(state))
  // comandi dal pannello remoto: li esegue l'interfaccia, che ha il motore di messa in onda
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let remoteSeq = 0
  ipcMain.on('remote:reply', (_e, id: number, ok: boolean, data: unknown, error: string) => {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    if (ok) w.resolve(data)
    else w.reject(new Error(error))
  })
  ponte.runInUi = (cmd: RemoteCommand, by: string) =>
    new Promise((resolve, reject) => {
      if (!win) return reject(new Error('regia non pronta'))
      const id = ++remoteSeq
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('la regia non ha risposto'))
      }, 8000)
      waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      win.webContents.send('remote:command', id, cmd, by)
    })
  ponte.onStatus((s) => win?.webContents.send('ponteStatus', s))

  library.onStatus((s) => win?.webContents.send('libraryStatus', s))

  createWindow()
  // riprende l'analisi lasciata a metà
  void library.analyzeAll()

  app.on('before-quit', () => {
    clearInterval(syncTimer)
    mb.stop()
    serverSync.stop()
    library.stop()
    ponte.stop()
    db.closeDanglingLog(new Date())
  })
})

app.on('window-all-closed', () => app.quit())
