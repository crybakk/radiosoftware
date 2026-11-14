import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PlayoutEngine, type PlayoutHost, type PlayoutSnapshot } from '../../core/playout'
import type { ScheduledEvent, Settings, Track } from '../../core/types'
import { DEFAULT_SETTINGS } from '../../core/types'
import { PreviewPlayer, WebAudioBackend } from './audio'

const api = window.radio

/** Crea una sola volta motore, uscita audio e preascolto, e li tiene allineati alle impostazioni. */
export function useRadio() {
  const backend = useMemo(() => new WebAudioBackend((t) => api.mediaUrl(t)), [])
  const preview = useMemo(() => new PreviewPlayer(), [])
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
        const steps = await api.expandEvent(event)
        // un evento può aver cambiato il profilo di rotazione
        if (event.actions.some((a) => a.type === 'rotation')) setSettings(await api.getSettings())
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
        autoQueueLength: s.autoQueueLength
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
    void api.getSettings().then(applySettings)
    void reloadEvents()
  }, [applySettings, reloadEvents])

  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => applySettings(await api.saveSettings(patch)),
    [applySettings]
  )

  return { engine, backend, preview, snapshot, settings, saveSettings, events, reloadEvents, cartTracks, audioError }
}

export type Radio = ReturnType<typeof useRadio>
