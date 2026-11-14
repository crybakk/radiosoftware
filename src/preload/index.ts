import { contextBridge, ipcRenderer } from 'electron'
import type { PonteStatus } from '../main/ponte'
import type { LibraryStatus, RadioApi } from '../shared/api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (channel: string): any => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api: RadioApi = {
  listFolders: call('listFolders'),
  chooseAndAddFolder: call('chooseAndAddFolder'),
  removeFolder: call('removeFolder'),
  scan: call('scan'),
  libraryStatus: call('libraryStatus'),
  search: call('search'),
  getTrack: call('getTrack'),
  getTracks: call('getTracks'),
  updateTrack: call('updateTrack'),
  mediaUrl: (t) => (/^https?:\/\//i.test(t.path) ? `media://stream/${encodeURIComponent(t.path)}` : `media://track/${t.id}`),
  listGenres: call('listGenres'),
  expandEvent: call('expandEvent'),
  choosePath: call('choosePath'),
  getSettings: call('getSettings'),
  saveSettings: call('saveSettings'),
  listEvents: call('listEvents'),
  saveEvent: call('saveEvent'),
  deleteEvent: call('deleteEvent'),
  fillQueue: call('fillQueue'),
  logStart: call('logStart'),
  logEnd: call('logEnd'),
  listLog: call('listLog'),
  exportLogCsv: call('exportLogCsv'),
  onLibraryStatus: (cb: (s: LibraryStatus) => void) => {
    const listener = (_e: unknown, s: LibraryStatus): void => cb(s)
    ipcRenderer.on('libraryStatus', listener)
    return () => ipcRenderer.removeListener('libraryStatus', listener)
  },
  ponteStatus: call('ponteStatus'),
  ponteCapture: call('ponteCapture'),
  sendPcm: (pcm: ArrayBuffer) => ipcRenderer.send('uplink:pcm', new Uint8Array(pcm)),
  ponteReport: call('ponteReport'),
  ponteBackupNow: call('ponteBackupNow'),
  ponteListBackups: call('ponteListBackups'),
  ponteState: call('ponteState'),
  ponteTestNotification: call('ponteTestNotification'),
  ponteRestore: call('ponteRestore'),
  restoredFrom: call('restoredFrom'),
  onPonteStatus: (cb: (s: PonteStatus) => void) => {
    const listener = (_e: unknown, s: PonteStatus): void => cb(s)
    ipcRenderer.on('ponteStatus', listener)
    return () => ipcRenderer.removeListener('ponteStatus', listener)
  }
}

contextBridge.exposeInMainWorld('radio', api)
