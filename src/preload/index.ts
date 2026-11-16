import { contextBridge, ipcRenderer } from 'electron'
import type { PonteStatus } from '../main/ponte'
import type { ServerSyncStatus } from '../main/serverSync'
import type { MbStatus } from '../main/musicbrainz'
import type { TagStatus } from '../main/tagServices'
import type { AiStatus } from '../main/ai'
import type { RemoteCommand, RemoteState } from '../core/remote'
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
  mediaUrl: (t) =>
    /^https?:\/\//i.test(t.path)
      ? `media://stream/${encodeURIComponent(t.path)}`
      : t.id < 0
        ? `media://file/${encodeURIComponent(t.path)}`
        : `media://track/${t.id}`,
  listGenres: call('listGenres'),
  expandEvent: call('expandEvent'),
  choosePath: call('choosePath'),
  newsTest: call('newsTest'),
  voiceList: call('voiceList'),
  voiceInstall: call('voiceInstall'),
  voiceRemove: call('voiceRemove'),
  voiceTest: call('voiceTest'),
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
  siaeReport: call('siaeReport'),
  exportSiaeCsv: call('exportSiaeCsv'),
  incompleteMusic: call('incompleteMusic'),
  mbStatus: call('mbStatus'),
  mbStart: call('mbStart'),
  mbStop: call('mbStop'),
  mbRetry: call('mbRetry'),
  onMbStatus: (cb: (s: MbStatus) => void) => {
    const listener = (_e: unknown, s: MbStatus): void => cb(s)
    ipcRenderer.on('mbStatus', listener)
    return () => ipcRenderer.removeListener('mbStatus', listener)
  },
  tagStatus: call('tagStatus'),
  tagStart: call('tagStart'),
  tagStop: call('tagStop'),
  tagRetry: call('tagRetry'),
  onTagStatus: (cb: (s: TagStatus) => void) => {
    const listener = (_e: unknown, s: TagStatus): void => cb(s)
    ipcRenderer.on('tagStatus', listener)
    return () => ipcRenderer.removeListener('tagStatus', listener)
  },
  aiStatus: call('aiStatus'),
  aiDownload: call('aiDownload'),
  aiCancelDownload: call('aiCancelDownload'),
  aiRemoveModel: call('aiRemoveModel'),
  aiGenerate: call('aiGenerate'),
  aiCancelGenerate: call('aiCancelGenerate'),
  aiPreview: call('aiPreview'),
  aiApply: call('aiApply'),
  onAiStatus: (cb: (s: AiStatus) => void) => {
    const listener = (_e: unknown, s: AiStatus): void => cb(s)
    ipcRenderer.on('aiStatus', listener)
    return () => ipcRenderer.removeListener('aiStatus', listener)
  },
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
  ponteListPrograms: call('ponteListPrograms'),
  ponteListeners: call('ponteListeners'),
  ponteReplay: call('ponteReplay'),
  ponteTestNotification: call('ponteTestNotification'),
  ponteRestore: call('ponteRestore'),
  restoredFrom: call('restoredFrom'),
  restoredEventsOff: call('restoredEventsOff'),
  serverSyncStatus: call('serverSyncStatus'),
  serverSyncList: call('serverSyncList'),
  serverSyncChoice: call('serverSyncChoice'),
  serverSyncNow: call('serverSyncNow'),
  serverSyncConfirmRemove: call('serverSyncConfirmRemove'),
  serverSyncStop: call('serverSyncStop'),
  serverSyncExport: call('serverSyncExport'),
  onServerSyncStatus: (cb: (s: ServerSyncStatus) => void) => {
    const listener = (_e: unknown, s: ServerSyncStatus): void => cb(s)
    ipcRenderer.on('serverSyncStatus', listener)
    return () => ipcRenderer.removeListener('serverSyncStatus', listener)
  },
  sendRemoteState: (state: RemoteState) => ipcRenderer.send('remote:state', state),
  onRemoteCommand: (cb: (cmd: RemoteCommand, by: string) => Promise<unknown>) => {
    const listener = (_e: unknown, id: number, cmd: RemoteCommand, by: string): void => {
      cb(cmd, by).then(
        (data) => ipcRenderer.send('remote:reply', id, true, data ?? null, ''),
        (e: unknown) => ipcRenderer.send('remote:reply', id, false, null, e instanceof Error ? e.message : String(e))
      )
    }
    ipcRenderer.on('remote:command', listener)
    return () => ipcRenderer.removeListener('remote:command', listener)
  },
  onPonteStatus: (cb: (s: PonteStatus) => void) => {
    const listener = (_e: unknown, s: PonteStatus): void => cb(s)
    ipcRenderer.on('ponteStatus', listener)
    return () => ipcRenderer.removeListener('ponteStatus', listener)
  }
}

contextBridge.exposeInMainWorld('radio', api)
