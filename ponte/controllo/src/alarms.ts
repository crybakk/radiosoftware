/**
 * Logica degli allarmi del ponte. Riceve gli eventi (da Liquidsoap e dalla regia)
 * e decide quando aprire o chiudere un allarme. Non invia nulla da sola: chi la usa
 * riceve le notifiche tramite il callback `notify`.
 */

export type AlarmKey = 'silenzio' | 'studio_scollegato' | 'regia_muta' | 'collegamento_instabile' | 'icecast_principale' | 'icecast_esterno' | 'disco_pieno'

export interface AlarmConfig {
  /** Secondi di regia scollegata dal ponte prima di avvisare. */
  disconnectedSeconds: number
  /** Secondi senza notizie dall'app della regia prima di avvisare. */
  heartbeatSeconds: number
  /** Quante riconnessioni in 10 minuti fanno scattare "collegamento instabile". */
  flapCount: number
}

export interface ActiveAlarm {
  key: AlarmKey
  since: string
  message: string
}

export const DEFAULT_ALARM_CONFIG: AlarmConfig = { disconnectedSeconds: 30, heartbeatSeconds: 90, flapCount: 5 }

const MESSAGES: Record<AlarmKey, [string, string]> = {
  silenzio: ['🔇 Silenzio in onda: dal ponte non arriva audio.', '🔊 Audio ripreso.'],
  studio_scollegato: [
    '📡 La regia è scollegata dal ponte: in onda va la musica di riserva del ponte.',
    '✅ La regia è di nuovo collegata al ponte.'
  ],
  regia_muta: [
    '💻 Il programma della regia non risponde (PC spento, app chiusa o internet assente).',
    '✅ Il programma della regia risponde di nuovo.'
  ],
  collegamento_instabile: [
    '⚠️ Collegamento instabile: la regia si è riconnessa molte volte negli ultimi 10 minuti.',
    '✅ Il collegamento della regia è tornato stabile.'
  ],
  icecast_principale: ["❌ Il ponte non riesce a mandare il segnale all'Icecast principale.", "✅ Il ponte trasmette di nuovo all'Icecast principale."],
  disco_pieno: [
    '💾 Disco del server quasi pieno: niente registrazione delle puntate, caricamenti e backup rifiutati.',
    '✅ Di nuovo spazio sul disco del server.'
  ],
  icecast_esterno: ["❌ Il ponte non riesce a mandare il segnale all'Icecast secondario (esterno).", "✅ Il ponte trasmette di nuovo all'Icecast secondario (esterno)."]
}

export class Alarms {
  private active = new Map<AlarmKey, ActiveAlarm>()
  private studioConnected = false
  private externalConnected = false
  private autonomousActive = false
  private disconnectedAt: number | null = null
  private lastHeartbeat: number | null = null
  private reconnects: number[] = []
  private lastIcecastError: string | null = null
  private config: AlarmConfig
  private notify: (text: string, alarm: AlarmKey | 'esterna', open: boolean) => void
  private now: () => number

  constructor(
    config: AlarmConfig,
    notify: (text: string, alarm: AlarmKey | 'esterna', open: boolean) => void,
    now: () => number = () => Date.now()
  ) {
    this.config = config
    this.notify = notify
    this.now = now
    // all'avvio consideriamo la regia scollegata finché non si collega
    this.disconnectedAt = now()
  }

  private open(key: AlarmKey, detail = ''): void {
    if (this.active.has(key)) return
    let message = MESSAGES[key][0] + (detail ? ` (${detail})` : '')
    if (key === 'studio_scollegato' && this.externalConnected) message = '📡 La regia è scollegata dal ponte (in onda c\'è la diretta esterna).'
    else if (key === 'studio_scollegato' && this.autonomousActive) message = '📡 La regia è scollegata dal ponte (in onda c\'è la diretta autonoma).'
    this.active.set(key, { key, since: new Date(this.now()).toISOString(), message })
    this.notify(message, key, true)
  }

  private close(key: AlarmKey): void {
    if (!this.active.delete(key)) return
    this.notify(MESSAGES[key][1], key, false)
  }

  private onAirSource(): boolean {
    return this.studioConnected || this.externalConnected || this.autonomousActive
  }

  /** Diretta autonoma dal server avviata o fermata (dal pannello). */
  setAutonomous(on: boolean): void {
    this.autonomousActive = on
  }

  /** Evento da Liquidsoap. */
  onEvent(kind: string, detail = ''): void {
    const t = this.now()
    switch (kind) {
      case 'studio_connesso':
        this.studioConnected = true
        this.disconnectedAt = null
        this.reconnects.push(t)
        this.close('studio_scollegato')
        break
      case 'studio_scollegato':
        this.studioConnected = false
        this.disconnectedAt = t
        break
      case 'esterna_collegata':
        this.externalConnected = true
        this.notify('🎙️ Diretta esterna collegata: è in onda al posto della regia.', 'esterna', true)
        break
      case 'esterna_scollegata':
        this.externalConnected = false
        this.notify(
          this.autonomousActive
            ? '🏠 Diretta esterna terminata: è tornata in onda la diretta autonoma.'
            : this.studioConnected
            ? '🏠 Diretta esterna terminata: è tornata in onda la regia.'
            : '🏠 Diretta esterna terminata. La regia non è collegata: in onda va la musica di riserva del ponte.',
          'esterna',
          false
        )
        break
      case 'silenzio':
        // il silenzio con nessuna sorgente collegata è già coperto da un altro allarme
        if (this.onAirSource()) this.open('silenzio', detail ? `da ${detail} secondi` : '')
        break
      case 'audio_ripreso':
        this.close('silenzio')
        break
      // il ponte ha sempre segnale (c'è la riserva): ogni errore verso un Icecast è un allarme
      case 'icecast_principale_errore':
        this.lastIcecastError = detail
        this.open('icecast_principale', detail)
        break
      case 'icecast_principale_collegato':
        this.lastIcecastError = null
        this.close('icecast_principale')
        break
      case 'icecast_esterno_errore':
        this.open('icecast_esterno', detail)
        break
      case 'icecast_esterno_collegato':
        this.close('icecast_esterno')
        break
    }
  }

  /**
   * Stato letto da Liquidsoap all'avvio del controllo: Liquidsoap avvisa solo dei cambiamenti, quindi
   * una regia (o un'esterna) già collegata prima del riavvio non risulterebbe mai collegata.
   * Non conta come riconnessione e non manda avvisi di collegamento.
   */
  sync(studio: boolean, external: boolean): void {
    if (studio && !this.studioConnected) {
      this.studioConnected = true
      this.disconnectedAt = null
      this.close('studio_scollegato')
    }
    if (external) this.externalConnected = true
  }

  /** Spazio sul disco del server sotto la soglia (true) o tornato (false). */
  setDiskFull(full: boolean, detail = ''): void {
    if (full) this.open('disco_pieno', detail)
    else this.close('disco_pieno')
  }

  onHeartbeat(): void {
    this.lastHeartbeat = this.now()
    this.close('regia_muta')
  }

  /** Da chiamare periodicamente (ogni pochi secondi). */
  tick(): void {
    const t = this.now()
    if (!this.studioConnected && this.disconnectedAt != null && t - this.disconnectedAt >= this.config.disconnectedSeconds * 1000) {
      this.open('studio_scollegato')
      // a regia scollegata il silenzio non ha senso come allarme separato
      this.close('silenzio')
    }
    if (this.lastHeartbeat != null && t - this.lastHeartbeat >= this.config.heartbeatSeconds * 1000) {
      this.open('regia_muta')
    }
    this.reconnects = this.reconnects.filter((r) => t - r < 10 * 60_000)
    if (this.reconnects.length >= this.config.flapCount) this.open('collegamento_instabile', `${this.reconnects.length} riconnessioni`)
    else if (this.reconnects.length <= 1 && this.studioConnected) this.close('collegamento_instabile')
  }

  status() {
    return {
      studioConnected: this.studioConnected,
      externalConnected: this.externalConnected,
      lastHeartbeat: this.lastHeartbeat ? new Date(this.lastHeartbeat).toISOString() : null,
      reconnectsLast10Min: this.reconnects.length,
      lastIcecastError: this.lastIcecastError,
      alarms: [...this.active.values()]
    }
  }
}
