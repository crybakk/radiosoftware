import { contextBridge, ipcRenderer } from 'electron'
import type { AggiornamentoStato, EsternaApi, StatoRegistrazioneLocale, StatoRegistrazioneProgrammi, StatoServer } from '../shared/api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (c: string): any => (...a: unknown[]) => ipcRenderer.invoke(c, ...a)
function ascolta<T>(canale: string, cb: (v: T) => void): () => void {
  const l = (_: unknown, v: T): void => cb(v)
  ipcRenderer.on(canale, l)
  return () => ipcRenderer.removeListener(canale, l)
}

const api: EsternaApi = {
  impostazioni: call('impostazioni'),
  salvaMixer: call('salvaMixer'),
  accedi: call('accedi'),
  esci: call('esci'),
  stato: call('stato'),
  onStato: (cb) => ascolta<StatoServer>('stato', cb),
  programmi: call('programmi'),
  meta: call('meta'),
  onda: call('onda'),
  audio: (pezzo, inizio) => ipcRenderer.send('audio', pezzo, inizio),
  onRiavviaInvio: (cb) => ascolta<void>('riavvia-invio', () => cb()),
  registrazione: call('registrazione'),
  onRegistrazione: (cb) => ascolta<StatoRegistrazioneProgrammi>('registrazione', cb),
  registra: call('registra'),
  segnaInizio: call('segnaInizio'),
  fineProgramma: call('fineProgramma'),
  registraLocale: call('registraLocale'),
  statoLocale: call('statoLocale'),
  onLocale: (cb) => ascolta<StatoRegistrazioneLocale>('locale', cb),
  pezzoRegistrazione: (pezzo) => ipcRenderer.send('pezzo-registrazione', pezzo),
  onPezzi: (cb) => ascolta<boolean>('pezzi', cb),
  apriCartella: call('apriCartella'),
  scegliCartella: call('scegliCartella'),
  permessoMicrofono: call('permessoMicrofono'),
  aggiornamento: call('aggiornamento'),
  controllaAggiornamenti: call('controllaAggiornamenti'),
  installaAggiornamento: call('installaAggiornamento'),
  onAggiornamento: (cb) => ascolta<AggiornamentoStato>('aggiornamento', cb),
  versione: call('versione'),
  piattaforma: process.platform as EsternaApi['piattaforma'],
  apriGuida: call('apriGuida')
}

contextBridge.exposeInMainWorld('esterna', api)
