/**
 * Sezioni del bot Telegram per gli eventi e la rotazione della regia (richiesta del 23/11/2026).
 * I comandi passano dal ponte alla regia come quelli del pannello. Gli eventi con un comando esterno
 * si vedono soltanto (si gestiscono dalla regia).
 */
import type { RemoteCommand, RemoteEvent, RemoteEventsInfo, RemoteRotationProfile } from './protocol.ts'
import type { Section, SectionView } from './telegram.ts'

type Run = (cmd: RemoteCommand, by: string) => Promise<unknown>

const DAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab']
const MAX_BUTTONS = 20

export function daysText(days: number[]): string {
  if (days.length === 7) return 'tutti i giorni'
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return 'lun-ven'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'weekend'
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => DAYS[d]).join(' ')
}

export function whenText(e: Pick<RemoteEvent, 'time' | 'repeatMinutes' | 'untilTime'>): string {
  if (e.time.startsWith('*')) return `ogni ora al minuto ${e.time.slice(2)}`
  if (e.repeatMinutes > 0) return `dalle ${e.time} ogni ${e.repeatMinutes} min${e.untilTime ? ` fino alle ${e.untilTime}` : ''}`
  return `alle ${e.time}`
}

/** Codice breve e stabile di un profilo, per i pulsanti (Telegram ammette 64 caratteri). */
export function profileCode(p: RemoteRotationProfile): string {
  const s = JSON.stringify([p.name, [...p.genres].sort(), p.yearFrom, p.yearTo, p.artistSeparationMinutes, p.jingleEvery, p.energyMin ?? null, p.energyMax ?? null])
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function profileText(p: RemoteRotationProfile): string {
  const parts = [p.name || 'profilo senza nome']
  if (p.genres.length) parts.push(`generi: ${p.genres.join(', ')}`)
  if (p.yearFrom || p.yearTo) parts.push(`anni ${p.yearFrom ?? '…'}-${p.yearTo ?? '…'}`)
  if (p.energyMin != null || p.energyMax != null) parts.push(`energia ${p.energyMin ?? 1}-${p.energyMax ?? 10}`)
  return parts.join(' · ')
}

const short = (s: string, n = 22): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const hm = (iso: string): string => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })

export function eventsView(info: RemoteEventsInfo): SectionView {
  const name = (e: RemoteEvent): string => e.label || `evento ${whenText(e)}`
  const lines = ['📅 Eventi della regia']
  const byId = new Map(info.events.map((e) => [e.id, e]))
  const today = new Date(info.at).toDateString()
  if (info.next.length) {
    lines.push('', 'Prossimi:')
    for (const n of info.next.slice(0, 6)) {
      const e = byId.get(n.id)
      const d = new Date(n.at)
      lines.push(`• ${d.toDateString() === today ? '' : `${DAYS[d.getDay()]} `}${hm(n.at)} ${e ? name(e) : ''}`)
    }
  }
  lines.push('', info.events.length ? 'Tutti (✅ acceso, ⏸ spento, 🔒 solo dalla regia):' : 'Nessun evento.')
  for (const e of info.events) lines.push(`${e.locked ? '🔒' : e.enabled ? '✅' : '⏸'} ${name(e)}: ${whenText(e)}, ${daysText(e.days)}`)
  const buttons: SectionView['buttons'] = []
  for (const e of info.events.filter((x) => !x.locked).slice(0, MAX_BUTTONS)) {
    buttons.push([
      { text: `${e.enabled ? '⏸ Spegni' : '✅ Accendi'} ${short(name(e))}`, data: `t:${e.id}:${e.enabled ? 0 : 1}` },
      { text: '▶ Esegui ora', data: `r:${e.id}` }
    ])
  }
  if (info.events.filter((x) => !x.locked).length > MAX_BUTTONS) lines.push('', `Pulsanti per i primi ${MAX_BUTTONS} eventi: gli altri si gestiscono dal pannello.`)
  return { text: lines.join('\n'), buttons }
}

export function rotationView(info: RemoteEventsInfo): SectionView {
  const r = info.rules
  const lines = ['🔁 Rotazione della regia', '']
  lines.push(info.rotation ? `Attiva: ${profileText(info.rotation)}` : 'Attiva: rotazione normale (tutta la musica)')
  lines.push(
    `Regole: stesso artista non prima di ${r.artistSeparationMinutes} min, stesso brano non prima di ${r.titleSeparationMinutes} min, ` +
      (r.jingleEvery > 0 ? `un jingle ogni ${r.jingleEvery} brani.` : 'niente jingle automatici.')
  )
  lines.push(`Mix DJ: ${info.djMix ? 'acceso' : 'spento'}.`)
  const others = info.profiles.slice(0, MAX_BUTTONS)
  if (others.length) lines.push('', 'Scegli la rotazione (resta fino al prossimo evento che la cambia):')
  const buttons: SectionView['buttons'] = others.map((p) => [{ text: `🎵 ${short(p.name || 'senza nome', 30)}`, data: `p:${profileCode(p)}` }])
  if (info.rotation) buttons.push([{ text: '↩ Torna alla rotazione normale', data: 'p:-' }])
  return { text: lines.join('\n'), buttons }
}

/** Sezioni "Eventi" e "Rotazione" del bot. */
export function eventSections(run: Run): Section[] {
  const info = (by = 'Telegram'): Promise<RemoteEventsInfo> => run({ type: 'events' }, by) as Promise<RemoteEventsInfo>
  return [
    {
      key: 'eventi',
      label: '📅 Eventi',
      render: async () => eventsView(await info()),
      act: async (data, by) => {
        const [what, idText, on] = data.split(':')
        const id = Number(idText)
        if (what === 'back') return
        const ev = (await info(by)).events.find((e) => e.id === id)
        if (!ev) return { toast: 'Evento non più presente' }
        const label = ev.label || whenText(ev)
        if (what === 't') {
          await run({ type: 'eventEnable', id, on: on === '1' }, by)
          return { toast: on === '1' ? `Acceso: ${label}` : `Spento: ${label}` }
        }
        if (what === 'r') {
          // conferma prima di mandare in onda
          return {
            view: {
              text: `▶ Eseguire subito l'evento "${label}"?\nLe sue azioni partono adesso in regia, come all'orario.`,
              buttons: [[{ text: '✅ Sì, esegui', data: `R:${id}` }, { text: '✖ Annulla', data: 'back' }]]
            }
          }
        }
        if (what === 'R') {
          await run({ type: 'eventRun', id }, by)
          return { toast: `Eseguito: ${label}` }
        }
        return { toast: 'Pulsante non valido' }
      }
    },
    {
      key: 'rotazione',
      label: '🔁 Rotazione',
      render: async () => rotationView(await info()),
      act: async (data, by) => {
        if (!data.startsWith('p:')) return { toast: 'Pulsante non valido' }
        const code = data.slice(2)
        if (code === '-') {
          await run({ type: 'rotationSet', profile: null }, by)
          return { toast: 'Rotazione normale' }
        }
        const p = (await info(by)).profiles.find((x) => profileCode(x) === code)
        if (!p) return { toast: 'Profilo non più presente: aggiorna' }
        await run({ type: 'rotationSet', profile: p }, by)
        return { toast: `Rotazione: ${p.name || 'senza nome'}` }
      }
    }
  ]
}
