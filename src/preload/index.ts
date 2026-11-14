import { contextBridge, ipcRenderer } from 'electron'
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
  mediaUrl: (id: number) => `media://track/${id}`,
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
  }
}

contextBridge.exposeInMainWorld('radio', api)
