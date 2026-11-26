import { useEffect, useState } from 'react'
import { ponteControlBase, ponteHostProblem, type PonteBackup, type PonteState } from '../../core/ponteClient'
import type { PonteSettings } from '../../core/types'
import { hhmm } from './format'
import { listInputDevices } from './uplinkCapture'
import { ServerLibrarySection } from './ServerLibrarySection'
import type { Radio } from './useRadio'
import { Riquadri } from './Riquadri'
import { collegaConCodice } from './Benvenuto'

const api = window.radio

/** Toglie il prefisso tecnico che Electron aggiunge agli errori. */
export function cleanError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const STATE_LABEL = { spento: 'Spento', connessione: 'Collegamento…', collegato: 'Collegato', riconnessione: 'Riconnessione' } as const

export function uplinkClass(state: string | undefined): string {
  if (state === 'collegato') return 'ok'
  if (state === 'connessione' || state === 'riconnessione') return 'warn'
  return 'off'
}

function since(iso: string | null): string {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `da ${s} s`
  if (s < 3600) return `da ${Math.floor(s / 60)} min`
  return `da ${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

function panelUrl(p: PonteSettings): string {
  return ponteControlBase(p.host, p.controlPort, p.controlHttps)
}

/** Secondi che mancano alla prossima riconnessione, ricalcolati a ogni secondo. */
function secondsTo(iso: string | null | undefined): number | null {
  if (!iso) return null
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000))
}

function sizeMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ConnectionView({ radio }: { radio: Radio }) {
  const [draft, setDraft] = useState<PonteSettings>(radio.settings.ponte)
  const [inputs, setInputs] = useState<{ deviceId: string; label: string }[]>([])
  const [remote, setRemote] = useState<PonteState | null>(null)
  const [backups, setBackups] = useState<PonteBackup[] | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const [codice, setCodice] = useState('')
  const [codiceMsg, setCodiceMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const st = radio.ponte
  const up = st?.uplink

  useEffect(() => setDraft(radio.settings.ponte), [radio.settings.ponte])
  useEffect(() => {
    if (draft.source === 'ingresso') void listInputDevices().then(setInputs)
  }, [draft.source])
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const configured = !!radio.settings.ponte.host && !!radio.settings.ponte.controlToken
  const dirty = JSON.stringify(draft) !== JSON.stringify(radio.settings.ponte)
  const set = <K extends keyof PonteSettings>(k: K, v: PonteSettings[K]): void => setDraft({ ...draft, [k]: v })
  const num = (k: keyof PonteSettings, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, Math.min(max, Math.max(min, Number(e.target.value) || min)) as never)

  const run = async (fn: () => Promise<string | void>): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const text = await fn()
      if (text) setMsg({ kind: 'ok', text })
    } catch (e) {
      setMsg({ kind: 'error', text: cleanError(e) })
    } finally {
      setBusy(false)
    }
  }

  const save = async (patch: Partial<PonteSettings> = {}): Promise<void> => {
    const p = { ...draft, ...patch }
    const hostProblem = ponteHostProblem(p.host)
    if (hostProblem) {
      setMsg({ kind: 'error', text: hostProblem })
      return
    }
    if (p.passphrase && (p.passphrase.length < 10 || p.passphrase.length > 79)) {
      setMsg({ kind: 'error', text: 'La frase segreta deve avere da 10 a 79 caratteri' })
      return
    }
    await radio.saveSettings({ ponte: p })
    setMsg(null)
  }

  
  return (
    <Riquadri className="settings-view" chiave="collegamento" nome="Collegamento">
      <section className="panel collega-codice" data-sezione="codice" data-titolo="Codice di collegamento">
        <div className="section-title">Collega la regia con il codice</div>
        <p className="hint">
          Il codice si copia dal pannello del server: Impostazioni server → Collega la regia. Incollalo qui e premi Collega:
          tutto il resto si sistema da solo.
        </p>
        <textarea
          className="codice-collegamento"
          rows={2}
          spellCheck={false}
          placeholder="Incolla qui il codice (inizia con RADIO-REGIA1.)"
          value={codice}
          onChange={(e) => {
            setCodice(e.target.value)
            setCodiceMsg(null)
          }}
        />
        <div className="row">
          <button
            className="primary"
            disabled={!codice.trim()}
            onClick={async () => {
              const e = await collegaConCodice(radio, codice)
              setCodiceMsg(e ? { kind: 'error', text: e } : { kind: 'ok', text: 'Fatto: la regia si sta collegando al server.' })
              if (!e) setCodice('')
            }}
          >
            Collega
          </button>
        </div>
        {codiceMsg && <div className={`banner ${codiceMsg.kind === 'ok' ? 'ok' : 'error'} inline-banner`}>{codiceMsg.text}</div>}
      </section>

      <section className="panel" data-sezione="invio" data-titolo="Collegamento al server">
        <div className="section-title">
          Collegamento al server
          <button
            className={radio.settings.ponte.enabled ? 'on' : 'primary'}
            disabled={!radio.settings.ponte.host || dirty}
            title={dirty ? 'Prima salva le impostazioni' : ''}
            onClick={() => void save({ enabled: !radio.settings.ponte.enabled })}
          >
            {radio.settings.ponte.enabled ? 'Acceso: premi per spegnere' : 'Accendi il collegamento'}
          </button>
        </div>
        <div className="link-status">
          <span className={`dot ${uplinkClass(up?.state)}`} />
          <strong>{up ? STATE_LABEL[up.state] : '…'}</strong>
          <span>{up?.message}</span>
          {up?.state === 'collegato' && <span className="info-line">{since(up.connectedSince)} · {up.kbps} kbit/s</span>}
          {up?.retryAt != null && <span className="info-line">nuovo tentativo tra {secondsTo(up.retryAt)} s</span>}
          {!!up?.reconnects && <span className="info-line">riconnessioni: {up.reconnects}</span>}
        </div>
        {radio.captureError && <div className="banner error inline-banner">{radio.captureError}</div>}
        {radio.settings.ponte.remoteControl && configured && (
          <div className="link-status">
            <span className={`dot ${st?.remote.state === 'collegato' ? 'ok' : st?.remote.state === 'spento' ? 'off' : 'warn'}`} />
            <strong>Pannello remoto</strong>
            <span>{st?.remote.message}</span>
            <span className="info-line">
              indirizzo: {panelUrl(radio.settings.ponte)}
            </span>
          </div>
        )}
        <p className="hint">
          Se il collegamento cade, la regia riprova da sola. Nel frattempo il server manda in onda la sua musica di riserva.
        </p>
      </section>

      <section className="panel" data-sezione="stato-ponte" data-titolo="Stato del server">
        <div className="section-title">Stato del server</div>
        {!configured && <p className="hint">Incolla il codice di collegamento qui sopra per vedere avvisi e backup.</p>}
        {configured && (
          <>
            <div className="link-status">
              <span className={`dot ${st?.controlOk ? 'ok' : st?.controlOk === false ? 'bad' : 'off'}`} />
              <strong>{st?.controlOk ? 'Servizio di controllo raggiungibile' : st?.controlOk === false ? 'Ponte non raggiungibile' : 'In attesa…'}</strong>
              {st?.controlError && <span>{st.controlError}</span>}
            </div>
            {st && st.alarms.length > 0 ? (
              <ul className="alarm-list">
                {st.alarms.map((a) => (
                  <li key={a.key}>
                    ⚠ {a.message} <span className="info-line">dalle {hhmm(a.since)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              st?.controlOk && <p className="info-line">Nessun allarme attivo.</p>
            )}
            {remote && (
              <p className="info-line">
                Il ponte riceve la regia: {remote.liquidsoap?.studio ? 'sì' : remote.liquidsoap ? 'no' : 'Liquidsoap non risponde'}
                {remote.liquidsoap?.esterna ? ' · in onda c\'è la diretta esterna' : ''} · notifiche:{' '}
                {remote.notifiche.length ? remote.notifiche.join(', ') : 'nessuna configurata'}
              </p>
            )}
            <div className="row">
              <button className="small" disabled={busy} onClick={() => void run(async () => setRemote(await api.ponteState()))}>
                Controlla il ponte
              </button>
              <button
                className="small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await api.ponteTestNotification()
                    if (!r.results.length) return 'Sul ponte non sono configurate notifiche (Telegram o email)'
                    return r.results.map((x) => `${x.channel}: ${x.ok ? 'inviata' : `errore (${x.error})`}`).join(' · ')
                  })
                }
              >
                Invia notifica di prova
              </button>
            </div>
          </>
        )}
        {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'} inline-banner`}>{msg.text}</div>}
      </section>

      {configured && (
        <section className="panel" data-sezione="backup" data-titolo="Backup del database">
          <div className="section-title">Backup del database</div>
          <p className="hint">
            Ogni giorno la regia salva sul ponte una copia di libreria, eventi, registro e impostazioni. Il ripristino
            riavvia la regia (la messa in onda si ferma per qualche secondo) e conserva a parte il database attuale.
            {st?.lastBackup ? ` Ultimo backup: ${new Date(st.lastBackup).toLocaleString('it-IT')}.` : ' Nessun backup ancora.'}
          </p>
          {st?.backupError && <div className="banner error inline-banner">Ultimo backup non riuscito: {st.backupError}</div>}
          <div className="row">
            <button className="small" disabled={busy || st?.backupRunning} onClick={() => void run(async () => `Backup salvato sul ponte: ${await api.ponteBackupNow()}`)}>
              {st?.backupRunning ? 'Backup in corso…' : 'Fai un backup adesso'}
            </button>
            <button className="small" disabled={busy} onClick={() => void run(async () => setBackups(await api.ponteListBackups()))}>
              Mostra i backup sul ponte
            </button>
          </div>
          {backups && (
            <table className="table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Dimensione</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {backups.length === 0 && (
                  <tr>
                    <td colSpan={3}>Nessun backup sul ponte.</td>
                  </tr>
                )}
                {backups.map((b) => (
                  <tr key={b.name}>
                    <td>{new Date(b.date).toLocaleString('it-IT')}</td>
                    <td>{sizeMb(b.size)}</td>
                    <td>
                      {confirm === b.name ? (
                        <span className="row tight">
                          <span className="info-line">La regia si riavvia. Sicuro?</span>
                          <button className="small danger" disabled={busy} onClick={() => void run(() => api.ponteRestore(b.name))}>
                            Sì, ripristina
                          </button>
                          <button className="small" onClick={() => setConfirm(null)}>
                            Annulla
                          </button>
                        </span>
                      ) : (
                        <button className="small danger" disabled={busy} onClick={() => setConfirm(b.name)}>
                          Ripristina
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="panel" data-sezione="impostazioni-collegamento" data-titolo="Impostazioni del collegamento">
        <details className="tecniche">
        <summary className="section-title">Impostazioni tecniche del collegamento</summary>
        <p className="hint">
          Di solito non serve toccarle: le compila il codice di collegamento. I valori devono coincidere con quelli del file
          .env sul server.
        </p>
        <div className="form-grid">
          <label>
            <span>
              Indirizzo del server <em>· il dominio della radio (DOMINIO), es. radio.esempio.it</em>
            </span>
            <input value={draft.host} onChange={(e) => set('host', e.target.value.trim())} placeholder="radio.esempio.it" />
          </label>
          <label>
            <span>
              Porta SRT <em>· SRT_PORT</em>
            </span>
            <input type="number" value={draft.srtPort} onChange={num('srtPort', 1, 65535)} />
          </label>
          <label>
            <span>
              Frase segreta <em>· SRT_PASSPHRASE</em>
            </span>
            <input type="password" value={draft.passphrase} onChange={(e) => set('passphrase', e.target.value)} />
          </label>
          <label>
            <span>
              Margine contro i buchi di rete (ms) <em>· più alto = più stabile, più ritardo</em>
            </span>
            <input type="number" step={250} value={draft.latencyMs} onChange={num('latencyMs', 120, 8000)} />
          </label>
          <label>
            <span>
              Qualità (kbit/s) <em>· 128 è ottima anche in 4G</em>
            </span>
            <select value={draft.bitrateKbps} onChange={(e) => set('bitrateKbps', Number(e.target.value))}>
              {[64, 96, 128, 160, 192, 256].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Cosa inviare</span>
            <select value={draft.source} onChange={(e) => set('source', e.target.value as PonteSettings['source'])}>
              <option value="programma">Solo il programma del computer (musica, jingle, eventi)</option>
              <option value="ingresso">Un ingresso della scheda audio (es. mix del RodeCaster con i microfoni)</option>
            </select>
          </label>
          {draft.source === 'ingresso' && (
            <label>
              <span>Ingresso audio</span>
              <select value={draft.inputDeviceId} onChange={(e) => set('inputDeviceId', e.target.value)}>
                {inputs.map((d) => (
                  <option key={d.deviceId || 'default'} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>
              Porta del servizio di controllo <em>· 443 con HTTPS</em>
            </span>
            <input type="number" value={draft.controlPort} onChange={num('controlPort', 1, 65535)} />
          </label>
          <label>
            <span>
              Token del servizio di controllo <em>· CONTROLLO_TOKEN</em>
            </span>
            <input type="password" value={draft.controlToken} onChange={(e) => set('controlToken', e.target.value.trim())} />
          </label>
          <label>
            <span>Backup automatico</span>
            <select value={draft.backupHour} onChange={(e) => set('backupHour', Number(e.target.value))}>
              <option value={-1}>Mai</option>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  Ogni giorno alle {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.controlHttps} onChange={(e) => set('controlHttps', e.target.checked)} />
            <span>Il servizio di controllo usa HTTPS (consigliato)</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.remoteControl} onChange={(e) => set('remoteControl', e.target.checked)} />
            <span>Permetti di comandare la regia dal pannello remoto</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.sendMetadata} onChange={(e) => set('sendMetadata', e.target.checked)} />
            <span>Invia artista e titolo agli ascoltatori (Icecast)</span>
          </label>
        </div>
        <div className="row end">
          <button disabled={!dirty} onClick={() => setDraft(radio.settings.ponte)}>
            Annulla modifiche
          </button>
          <button className="primary" disabled={!dirty} onClick={() => void save()}>
            Salva
          </button>
        </div>
        </details>
      </section>
      <ServerLibrarySection draft={draft} set={set} />
    </Riquadri>
  )
}
