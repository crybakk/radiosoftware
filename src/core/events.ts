import type { ScheduledEvent } from './types'

/**
 * Restituisce le occorrenze degli eventi con orario nell'intervallo (from, to].
 * Gli orari sono locali (quelli del PC di regia).
 */
export function dueEvents(events: ScheduledEvent[], from: Date, to: Date): { event: ScheduledEvent; at: Date }[] {
  if (to <= from) return []
  // Evita raffiche dopo una lunga sospensione del PC: guarda al massimo 2 minuti indietro.
  const start = new Date(Math.max(from.getTime(), to.getTime() - 2 * 60_000))
  const out: { event: ScheduledEvent; at: Date }[] = []
  for (const ev of events) {
    if (!ev.enabled) continue
    const [hPart, mPart] = ev.time.split(':')
    const mm = Number(mPart)
    if (hPart === '*') {
      // ogni ora al minuto indicato
      const at = new Date(start)
      at.setMinutes(mm, 0, 0)
      if (at <= start) at.setHours(at.getHours() + 1)
      for (; at <= to; at.setHours(at.getHours() + 1)) {
        if (ev.days.includes(at.getDay())) out.push({ event: ev, at: new Date(at) })
      }
      continue
    }
    const hh = Number(hPart)
    // controlla il giorno di "start" e quello di "to" (l'intervallo può scavalcare la mezzanotte)
    const days = new Set([start.toDateString(), to.toDateString()])
    for (const ds of days) {
      const at = new Date(ds)
      at.setHours(hh, mm, 0, 0)
      if (at > start && at <= to && ev.days.includes(at.getDay())) out.push({ event: ev, at })
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime())
}
