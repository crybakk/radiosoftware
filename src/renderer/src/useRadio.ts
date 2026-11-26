import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PlayoutEngine, restoreAndPersistMode, type PlayoutHost, type PlayoutSnapshot } from '../../core/playout'
import type { ScheduledEvent, Settings, Track } from '../../core/types'
import { DEFAULT_SETTINGS } from '../../core/types'
import type { PonteStatus } from '../../main/ponte'
import { PreviewPlayer, WebAudioBackend } from './audio'
import { UplinkCapture } from './uplinkCapture'
import { executeRemote, toRemoteState } from '../../core/remote'

const api = window.radio

/** Crea una sola volta motore, uscita audio e preascolto, e li tiene allineati alle impostazioni. */
export function useRadio() {
  const backend = useMemo(() => new WebAudioBackend((t) => api.mediaUrl(t)), [])
  const preview = useMemo(() => new PreviewPlayer(), [])
  const capture = useMemo(() => new UplinkCapture(backend.ctx, backend.master, (pcm) => api.sendPcm(pcm)), [backend])
  const engineRef = useRef<PlayoutEngine | null>(null)
  if (!engineRef.current) {
    const host: PlayoutHost = {
      fillQueue: (upcoming, count) =>
        api.fillQueue(
          upcoming.map((u) => ({ trackId: u.track.id, at: u.at.toISOString() })),
          count
        ),
      logStart: (track, at) => api.logStart(track, at.toISOString()),
      logEnd: (id, at, seconds) => api.logEnd(id, at.toISOString(), seconds),
      expandEvent: async (event) => {
        // brano in onda e prossimo, per gli annunci con la voce sintetica
        const snap = engineRef.current?.snapshot()
        const on = snap?.onAir.map((o) => o.track) ?? []
        const cur = on.find((t) => t.kind === 'music') ?? on.at(-1)
        const next = snap?.queue.find((q) => q.track.kind === 'music')?.track
        const steps = await api.expandEvent(event, {
          track: cur ? { title: cur.title, artist: cur.artist } : null,
          nextTrack: next ? { title: next.title, artist: next.artist } : null
        })
        // un evento può aver cambiato il profilo di rotazione o acceso/spento il Mix DJ
        if (event.actions.some((a) => a.type === 'rotation' || a.type === 'djMix')) {
          const s = await api.getSettings()
          setSettings(s)
          engineRef.current?.setOptions({ djMix: s.djMix, djMaxStretch: s.djMaxStretch, djStyles: s.djStyles })
        }
        return steps
      }
    }
    engineRef.current = new PlayoutEngine(backend, host, {
      crossfadeSeconds: DEFAULT_SETTINGS.crossfadeSeconds,
      targetLoudness: DEFAULT_SETTINGS.targetLoudness,
      autoQueueLength: DEFAULT_SETTINGS.autoQueueLength
    })
  }
  const engine = engineRef.current

  const [snapshot, setSnapshot] = useState<PlayoutSnapshot>(() => engine.snapshot())
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [events, setEvents] = useState<ScheduledEvent[]>([])
  const [cartTracks, setCartTracks] = useState<(Track | null)[]>(Array(12).fill(null))
  const [audioError, setAudioError] = useState<string | null>(null)
  const [ponte, setPonte] = useState<PonteStatus | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)

  useEffect(() => {
    void api.ponteStatus().then(setPonte)
    return api.onPonteStatus(setPonte)
  }, [])

  // stato della regia per il ponte (segnale di vita)
  const main = snapshotMain(snapshot)
  useEffect(() => {
    void api.ponteReport(main)
  }, [main.mode, main.onAir, main.artist, main.title]) // eslint-disable-line react-hooks/exhaustive-deps

  // pannello remoto: stato inviato a ogni cambiamento e ogni secondo, comandi eseguiti sul motore
  const cartsRef = useRef(cartTracks)
  cartsRef.current = cartTracks
  useEffect(() => {
    const push = (): void => api.sendRemoteState(toRemoteState(engine.snapshot(), cartsRef.current, ''))
    const unsub = engine.subscribe(push)
    const t = setInterval(push, 1000)
    return () => {
      unsub()
      clearInterval(t)
    }
  }, [engine])
  // cattura dell'audio da inviare: segue le impostazioni del ponte
  const captureKey = JSON.stringify([settings.ponte.enabled, settings.ponte.source, settings.ponte.inputDeviceId])
  useEffect(() => {
    let cancelled = false
    const p = settings.ponte
    if (!p.enabled) {
      capture.stop()
      void api.ponteCapture(false, 0)
      setCaptureError(null)
      return
    }
    capture
      .start(p)
      .then(() => {
        if (cancelled) return
        setCaptureError(null)
        return api.ponteCapture(true, backend.ctx.sampleRate)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        void api.ponteCapture(false, 0)
        setCaptureError(
          p.source === 'ingresso'
            ? `L'ingresso audio scelto per il server non si apre: controlla che il RodeCaster sia acceso e collegato (${e instanceof Error ? e.message : String(e)})`
            : `Il collegamento al server non è partito: chiudi e riapri la regia (${e instanceof Error ? e.message : String(e)})`
        )
      })
    return () => {
      cancelled = true
      // ferma anche un avvio ancora in corso: al prossimo giro ne parte uno solo
      capture.stop()
    }
  }, [captureKey, capture, backend]) // eslint-disable-line react-hooks/exhaustive-deps

  // ciclo del motore
  useEffect(() => {
    const unsub = engine.subscribe(setSnapshot)
    let busy = false
    const timer = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        await engine.tick()
      } finally {
        busy = false
      }
    }, 200)
    return () => {
      unsub()
      clearInterval(timer)
    }
  }, [engine])

  const applySettings = useCallback(
    async (s: Settings) => {
      setSettings(s)
      engine.setOptions({
        crossfadeSeconds: s.crossfadeSeconds,
        targetLoudness: s.targetLoudness,
        autoQueueLength: s.autoQueueLength,
        djMix: s.djMix,
        djMaxStretch: s.djMaxStretch,
        djStyles: s.djStyles
      })
      try {
        await backend.setOutputDevice(s.outputDeviceId)
        await preview.setOutputDevice(s.previewDeviceId)
        setAudioError(null)
      } catch {
        setAudioError('La scheda audio scelta non è disponibile: controlla che il RodeCaster sia collegato.')
      }
      const ids = s.cartwall.filter((x): x is number => x != null)
      const tracks = new Map((await api.getTracks(ids)).map((t) => [t.id, t]))
      setCartTracks(s.cartwall.map((id) => (id == null ? null : (tracks.get(id) ?? null))))
    },
    [engine, backend, preview]
  )

  const reloadEvents = useCallback(async (list?: ScheduledEvent[]) => {
    const ev = list ?? (await api.listEvents())
    setEvents(ev)
    engine.setEvents(ev)
  }, [engine])

  useEffect(() => {
    let cancelled = false
    let unfollow: (() => void) | null = null
    void api.getSettings().then((s) => {
      if (cancelled) return
      void applySettings(s)
      // modalità com'era alla chiusura (o al blackout), poi salvata a ogni cambio
      unfollow = restoreAndPersistMode(engine, s.playoutMode, (mode) => {
        setSettings((cur) => ({ ...cur, playoutMode: mode }))
        void api.saveSettings({ playoutMode: mode })
      })
    })
    void reloadEvents()
    return () => {
      cancelled = true
      unfollow?.()
    }
  }, [applySettings, reloadEvents, engine])

  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      // la modalità la salva solo il motore: una copia vecchia delle impostazioni (es. dalla scheda
      // Impostazioni) non deve riportarla indietro
      const { playoutMode: _mode, ...rest } = patch
      return applySettings(await api.saveSettings(rest))
    },
    [applySettings]
  )

  // comandi dal pannello remoto e da Telegram, eseguiti sul motore (anche eventi e rotazioni)
  useEffect(
    () =>
      api.onRemoteCommand((cmd, by) =>
        executeRemote(engine, cmd, {
          getTrack: (id) => api.getTrack(id),
          search: async (q) => (await api.search({ text: q, limit: 50 })).tracks,
          carts: () => cartsRef.current,
          replay: (programId, episodeId) => api.ponteReplay(programId, episodeId),
          events: {
            listEvents: () => api.listEvents(),
            saveEvent: async (e) => {
              const list = await api.saveEvent(e)
              await reloadEvents(list)
              return list
            },
            deleteEvent: async (id) => {
              const list = await api.deleteEvent(id)
              await reloadEvents(list)
              return list
            },
            getSettings: () => api.getSettings(),
            saveSettings: async (patch) => {
              await saveSettings(patch)
            },
            runEvent: (e) => engine.runEvent(e),
            getTracks: (ids) => api.getTracks(ids),
            listGenres: () => api.listGenres(),
            ai: {
              status: () => api.aiStatus(),
              generate: (description) => api.aiGenerate(description),
              cancel: () => api.aiCancelGenerate(),
              preview: (plan) => api.aiPreview(plan),
              apply: async (plan, replace) => {
                const list = await api.aiApply(plan, replace)
                await reloadEvents(list)
                return list
              }
            }
          }
        }, by)
      ),
    [engine, reloadEvents, saveSettings]
  )

  return { engine, backend, preview, snapshot, settings, saveSettings, events, reloadEvents, cartTracks, audioError, ponte, captureError }
}

export type Radio = ReturnType<typeof useRadio>

function snapshotMain(s: PlayoutSnapshot): { mode: 'auto' | 'manual'; onAir: boolean; artist: string; title: string } {
  const cur = s.onAir.at(-1)
  return { mode: s.mode, onAir: !!cur, artist: cur?.track.artist ?? '', title: cur?.track.title ?? '' }
}
