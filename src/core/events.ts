import type { ScheduledEvent } from './types'

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseHm(s: string | null | undefined): [number, number] | null {
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** Tutti gli orari in cui l'evento scatta nel giorno `day` (ora locale). */
export function occurrencesOnDay(ev: ScheduledEvent, day: Date): Date[] {
  if (!ev.enabled || !ev.actions.length) return []
  if (!ev.days.includes(day.getDay())) return []
  const iso = isoDay(day)
  if (ev.validFrom && iso < ev.validFrom) return []
  if (ev.validTo && iso > ev.validTo) return []

  const base = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  const [hPart, mPart] = ev.time.split(':')
  const minute = Number(mPart)
  const out: Date[] = []

  if (hPart === '*') {
    for (let h = 0; h < 24; h++) {
      const at = new Date(base)
      at.setHours(h, minute, 0, 0)
      out.push(at)
    }
    return out
  }

  const start = new Date(base)
  start.setHours(Number(hPart), minute, 0, 0)
  if (ev.repeatMinutes > 0) {
    const until = new Date(base)
    const u = parseHm(ev.untilTime)
    if (u) until.setHours(u[0], u[1], 0, 0)
    else until.setHours(23, 59, 59, 999)
    for (let at = new Date(start); at <= until && at.getDate() === base.getDate(); ) {
      out.push(new Date(at))
      at = new Date(at.getTime() + ev.repeatMinutes * 60_000)
    }
    return out
  }
  return [start]
}

/**
 * Restituisce le occorrenze degli eventi con orario nell'intervallo (from, to].
 * Gli orari sono locali (quelli del PC di regia).
 */
export function dueEvents(events: ScheduledEvent[], from: Date, to: Date): { event: ScheduledEvent; at: Date }[] {
  if (to <= from) return []
  // Evita raffiche dopo una lunga sospensione del PC: guarda al massimo 2 minuti indietro.
  const start = new Date(Math.max(from.getTime(), to.getTime() - 2 * 60_000))
  const days = new Map<string, Date>()
  for (const d of [start, to]) days.set(d.toDateString(), d)
  const out: { event: ScheduledEvent; at: Date }[] = []
  for (const ev of events) {
    for (const d of days.values()) {
      for (const at of occurrencesOnDay(ev, d)) {
        if (at > start && at <= to) out.push({ event: ev, at })
      }
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** Prossime occorrenze (per mostrarle nell'interfaccia). */
export function nextOccurrences(events: ScheduledEvent[], from: Date, count: number): { event: ScheduledEvent; at: Date }[] {
  const out: { event: ScheduledEvent; at: Date }[] = []
  for (let dayOffset = 0; dayOffset < 8 && out.length < count * 4; dayOffset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset)
    for (const ev of events) for (const at of occurrencesOnDay(ev, day)) if (at > from) out.push({ event: ev, at })
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, count)
}
