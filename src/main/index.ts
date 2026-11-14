import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { logToCsv } from '../core/csv'
import { RadioDb, type TrackEdit, type TrackSearch } from '../core/db'
import { RotationService } from '../core/rotationService'
import type { ScheduledEvent, Settings, TrackKind } from '../core/types'
import { LibraryService } from './library'
import { serveFile } from './media'

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
  const db = new RadioDb(join(app.getPath('userData'), 'radio.db'))
  db.closeDanglingLog(new Date())
  const library = new LibraryService(db, ffmpegPath())
  const rotation = new RotationService(db)

  protocol.handle('media', (request) => {
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
  handle('saveSettings', (patch: Partial<Settings>) => db.saveSettings(patch))

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
  handle('logStart', (trackId: number, at: string) => {
    const t = db.getTrack(trackId)
    return t ? db.logStart(t, new Date(at)) : -1
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

  library.onStatus((s) => win?.webContents.send('libraryStatus', s))

  createWindow()
  // riprende l'analisi lasciata a metà
  void library.analyzeAll()

  app.on('before-quit', () => {
    library.stop()
    db.closeDanglingLog(new Date())
  })
})

app.on('window-all-closed', () => app.quit())
