import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ListenerStats } from '../../core/ponteClient'
import { cleanError } from './ConnectionView'
import { Riquadri } from './Riquadri'

/**
 * Ascoltatori: gli stessi dati del pannello remoto, letti dal ponte (Icecast principale e secondario,
 * un campione al minuto, storico di un anno).
 */

const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const num = (n: number): string => (Math.round(n * 10) / 10).toLocaleString('it-IT')

/** Massimo dell'asse: 4 righe con passo tondo (1, 2, 5 × 10^n). */
function niceMax(v: number): number {
  const raw = Math.max(1, v / 4)
  const p = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw) ?? raw) * 4
}

interface Tip {
  x: number
  y: number
  content: ReactNode
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null
  return (
    <div className="viz-tip" style={{ left: `${tip.x}%`, top: `${tip.y}%` }}>
      {tip.content}
    </div>
  )
}

function Grid({ max, y, L, R, W }: { max: number; y: (v: number) => number; L: number; R: number; W: number }) {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => {
        const v = (max / 4) * i
        return (
          <g key={i}>
            <line className="viz-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end">
              {num(v)}
            </text>
          </g>
        )
      })}
    </>
  )
}

function LineChart({ r }: { r: ListenerStats }) {
  const W = 800, H = 240, L = 36, R = 10, T = 10, B = 24
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const max = niceMax(Math.max(1, ...r.series.map((p) => p.peak)))
  const half = (r.step * 60_000) / 2
  const x = (t: number): number => L + ((t - r.from) / (r.to - r.from)) * (W - L - R)
  const y = (v: number): number => T + (1 - v / max) * (H - T - B)
  const week = r.to - r.from > 2 * 86_400_000
  const ticks: number[] = []
  for (let t = r.from; t < r.to; t += week ? 86_400_000 : 3 * 3600_000) ticks.push(t)
  // segmenti separati dove mancano i dati
  const runs: (typeof r.series)[] = []
  for (const p of r.series) {
    const last = runs.at(-1)?.at(-1)
    if (!last || p.t - last.t > r.step * 60_000 * 1.5) runs.push([p])
    else runs.at(-1)!.push(p)
  }
  const line = runs.map((run) => `M${run.map((p) => `${x(p.t + half).toFixed(1)},${y(p.avg).toFixed(1)}`).join('L')}`).join('')
  const area = runs
    .map((run) => `M${x(run[0].t + half)},${y(0)}L${run.map((p) => `${x(p.t + half).toFixed(1)},${y(p.avg).toFixed(1)}`).join('L')}L${x(run.at(-1)!.t + half)},${y(0)}Z`)
    .join('')
  const p = hover === null ? null : r.series[hover]
  const label = (t: number): string =>
    new Date(t).toLocaleString('it-IT', week ? { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
  const move = (e: React.PointerEvent): void => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || !r.series.length) return
    const t = r.from + ((((e.clientX - rect.left) / rect.width) * W - L) / (W - L - R)) * (r.to - r.from)
    let best = 0
    r.series.forEach((q, i) => {
      if (Math.abs(q.t - t) < Math.abs(r.series[best].t - t)) best = i
    })
    setHover(best)
  }
  return (
    <div className="viz">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Ascoltatori nel periodo">
        <Grid max={max} y={y} L={L} R={R} W={W} />
        {ticks.map((t) => (
          <text key={t} x={x(t) + (week ? 4 : 0)} y={H - 6} textAnchor={week ? 'start' : 'middle'}>
            {week
              ? new Date(t).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' })
              : new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
          </text>
        ))}
        <path className="viz-area" d={area} />
        <path className="viz-line" d={line} />
        {p && (
          <>
            <line className="viz-cross" x1={x(p.t + half)} x2={x(p.t + half)} y1={T} y2={H - B} />
            <circle className="viz-dot" cx={x(p.t + half)} cy={y(p.avg)} r={4} />
          </>
        )}
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHover(null)} />
      </svg>
      <Tooltip
        tip={
          p && {
            x: (x(p.t + half) / W) * 100,
            y: (y(p.avg) / H) * 100,
            content: (
              <>
                {label(p.t)}
                <b>{num(p.avg)} in media</b>
                picco {p.peak} · principale {num(p.a)}
                {p.b !== null && ` · secondario ${num(p.b)}`}
              </>
            )
          }
        }
      />
    </div>
  )
}

function HourChart({ hours }: { hours: ListenerStats['byHour'] }) {
  const W = 800, H = 200, L = 36, R = 10, T = 10, B = 22
  const [hover, setHover] = useState<number | null>(null)
  const max = niceMax(Math.max(1, ...hours.map((h) => h.avg)))
  const y = (v: number): number => T + (1 - v / max) * (H - T - B)
  const bw = (W - L - R) / 24
  const h = hover === null ? null : hours[hover]
  return (
    <div className="viz">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Media degli ascoltatori per ora del giorno">
        <Grid max={max} y={y} L={L} R={R} W={W} />
        {hours.map((b) => {
          const bx = L + b.hour * bw + 1
          const w = bw - 2
          const top = y(b.avg)
          const height = Math.max(0, y(0) - top)
          const rr = Math.min(4, height, w / 2)
          const d = height > 0 ? `M${bx},${y(0)}V${top + rr}Q${bx},${top} ${bx + rr},${top}H${bx + w - rr}Q${bx + w},${top} ${bx + w},${top + rr}V${y(0)}Z` : ''
          return (
            <g key={b.hour}>
              <path className={`viz-bar ${hover === b.hour ? 'dim' : ''}`} d={d} />
              {b.hour % 3 === 0 && (
                <text x={bx + w / 2} y={H - 6} textAnchor="middle">
                  {b.hour}
                </text>
              )}
              <rect x={bx - 1} y={T} width={bw} height={H - T - B} fill="transparent" onPointerEnter={() => setHover(b.hour)} onPointerLeave={() => setHover(null)} />
            </g>
          )
        })}
      </svg>
      <Tooltip
        tip={
          h && {
            x: ((L + h.hour * bw + bw / 2) / W) * 100,
            y: (y(h.avg) / H) * 100,
            content: (
              <>
                dalle {String(h.hour).padStart(2, '0')}:00
                <b>{num(h.avg)} in media</b>
                picco {h.peak}
              </>
            )
          }
        }
      />
    </div>
  )
}

export function StatsView() {
  const [kind, setKind] = useState<'giorno' | 'settimana'>('giorno')
  const [date, setDate] = useState(isoDay(new Date()))
  const [r, setR] = useState<ListenerStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void =>
      void window.radio
        .ponteListeners(kind, date)
        .then((x) => {
          if (!alive) return
          setR(x)
          setError(null)
        })
        .catch((e: unknown) => alive && setError(cleanError(e)))
    load()
    const t = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [kind, date])

  const shift = (dir: number): void => {
    const d = new Date(`${date}T12:00:00`)
    d.setDate(d.getDate() + dir * (kind === 'settimana' ? 7 : 1))
    setDate(isoDay(d))
  }
  const now = r?.now ? r.now.a + (r.now.b ?? 0) : null
  const when = (t: number): string =>
    new Date(t).toLocaleString('it-IT', kind === 'settimana' ? { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' })

  return (
    <Riquadri className="stats-view" chiave="ascoltatori" nome="Ascoltatori">
      <section className="panel" data-sezione="ascoltatori" data-titolo="Ascoltatori">
        <div className="section-title">Ascoltatori</div>
        <div className="row">
          <button className={kind === 'giorno' ? 'primary' : ''} onClick={() => setKind('giorno')}>
            Giorno
          </button>
          <button className={kind === 'settimana' ? 'primary' : ''} onClick={() => setKind('settimana')}>
            Settimana
          </button>
          <button onClick={() => shift(-1)} aria-label="Periodo prima">
            ◀
          </button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button onClick={() => shift(1)} aria-label="Periodo dopo">
            ▶
          </button>
        </div>
        {error && <div className="banner error">Statistiche non disponibili: {error}</div>}
        {r && (
          <>
            <div className="tiles">
              <div className="tile">
                <div className="v">{now ?? '–'}</div>
                <div className="l">adesso</div>
              </div>
              <div className="tile">
                <div className="v">{r.peak}</div>
                <div className="l">{r.peakAt ? `picco (${when(r.peakAt)})` : 'picco'}</div>
              </div>
              <div className="tile">
                <div className="v">{num(r.avg)}</div>
                <div className="l">media</div>
              </div>
              <div className="tile">
                <div className="v">{num(r.hours)}</div>
                <div className="l">ore di ascolto</div>
              </div>
            </div>
            <div className="hint">
              {r.now && `Adesso: ${r.now.a} sul principale${r.now.b === null ? '' : `, ${r.now.b} sul secondario`}. `}
              {r.secondary && r.now && r.now.b === null && "Gli ascoltatori del secondo server d'ascolto non si riescono a leggere (vedi la guida). "}
              {!r.series.length && 'Nessun dato in questo periodo.'}
            </div>
          </>
        )}
      </section>
      {r && (
        <>
          <section className="panel" data-sezione="andamento" data-titolo="Andamento">
            <div className="section-title">{kind === 'settimana' ? 'Andamento della settimana (media per ora)' : 'Andamento del giorno (media ogni 10 minuti)'}</div>
            <LineChart r={r} />
          </section>
          <section className="panel" data-sezione="per-ora" data-titolo="Per ora del giorno">
            <div className="section-title">Per ora del giorno (media)</div>
            <HourChart hours={r.byHour} />
          </section>
          <section className="panel" data-sezione="per-programma" data-titolo="Per programma">
            <div className="section-title">Per programma</div>
            <table className="table">
              <thead>
                <tr>
                  <th>Programma</th>
                  <th>Media</th>
                  <th>Picco</th>
                  <th>Ore di ascolto</th>
                </tr>
              </thead>
              <tbody>
                {r.byProgram.map((p) => (
                  <tr key={p.id}>
                    <td>{p.title}</td>
                    <td>{num(p.avg)}</td>
                    <td>{p.peak}</td>
                    <td>{num(p.hours)}</td>
                  </tr>
                ))}
                {!r.byProgram.length && (
                  <tr>
                    <td colSpan={4} className="hint">
                      Nessun programma in onda in questo periodo.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </Riquadri>
  )
}
