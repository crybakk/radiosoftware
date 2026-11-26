import { useEffect, useState } from 'react'
import type { Track } from '../../core/types'
import { MIX_STYLES, type MixStyle } from '../../core/djMix'
import { introLeft, introSeconds } from '../../core/intro'
import { hhmm, KIND_LABEL, mmss } from './format'
import { TrackSearch } from './TrackSearch'
import type { Radio } from './useRadio'
import { Riquadri } from './Riquadri'
import { RegistrazioneBox } from './RegistrazioneBox'
import { EsternaBox } from './EsternaBox'
import { TitoloParlatoBox } from './TitoloParlatoBox'
import { useConferma } from './Conferma'

function Meter({ radio }: { radio: Radio }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let raf = 0
    let held = 0
    const loop = (): void => {
      const p = radio.backend.peak()
      held = Math.max(p, held * 0.92)
      setLevel(held)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [radio.backend])
  const db = level > 0 ? 20 * Math.log10(level) : -60
  const pct = Math.max(0, Math.min(100, ((db + 48) / 48) * 100))
  return (
    <div className="meter" title={`${db.toFixed(1)} dBFS`}>
      <div className={`meter-fill ${db > -1 ? 'clip' : db > -6 ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function PreviewButton({ radio, track }: { radio: Radio; track: Track }) {
  const [, force] = useState(0)
  const active = radio.preview.trackId === track.id && radio.preview.playing
  return (
    <button
      className={`small ${active ? 'on' : ''}`}
      title="Preascolto in cuffia"
      onClick={async () => {
        if (active) radio.preview.stop()
        else await radio.preview.play(window.radio.mediaUrl(track), track.id, track.cueIn)
        force((n) => n + 1)
      }}
    >
      {active ? '■ Cuffia' : '🎧'}
    </button>
  )
}

export function OnAirView({ radio }: { radio: Radio }) {
  const { snapshot: s, engine } = radio
  const main = s.onAir.at(-1)
  const fading = s.onAir.slice(0, -1)
  const progress = main ? Math.min(100, (main.position / Math.max(1, main.track.cueOut || main.track.duration)) * 100) : 0
  const ending = main && main.remaining < 10
  const intro = main ? introLeft(main.track, main.position) : null
  const [djStyle, setDjStyle] = useState<MixStyle | ''>('')
  const conferma = useConferma()
  const stop = async (): Promise<void> => {
    const ok = await conferma({
      titolo: 'Fermare la musica?',
      testo: 'Il brano in onda si interrompe subito e la radio resta senza musica finché non premi PLAY.',
      si: 'Sì, ferma la musica'
    })
    if (ok) engine.stop()
  }
  const svuota = async (): Promise<void> => {
    const ok = await conferma({
      titolo: 'Togliere tutti i brani dalla coda?',
      testo:
        s.mode === 'auto'
          ? 'In AUTOMATICO la regia la riempie di nuovo da sola.'
          : 'In MANUALE, finito il brano in onda, la musica si ferma.',
      si: 'Sì, svuota la coda'
    })
    if (ok) engine.clearQueue()
  }

  return (
    <div className="onair-view">
      <Riquadri as="section" className="left" chiave="onair-sinistra" nome="In onda, colonna sinistra">
        <EsternaBox radio={radio} />
        <RegistrazioneBox />
        <div className={`now ${ending ? 'ending' : ''}`} data-sezione="now" data-titolo="Brano in onda">
          {main ? (
            <>
              <div className="now-kind">{KIND_LABEL[main.track.kind]}</div>
              <div className="now-title">{main.track.title}</div>
              <div className="now-artist">{main.track.artist}</div>
              <div className="progress">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="now-times">
                <span>{mmss(main.position)}</span>
                <span className="remaining">-{mmss(main.remaining)}</span>
              </div>
              {intro !== null && (
                <div className={`now-intro ${intro <= 3 ? 'last' : ''}`} title="Tempo che resta prima che parta la voce o il pezzo pieno">
                  🎙 Intro {Math.ceil(intro)} s
                </div>
              )}
              {(s.mode === 'auto' || s.dj.once) && s.queue.length > 0 && (
                <div className="now-mix">Prossimo tra {mmss(main.toMix)}</div>
              )}
            </>
          ) : (
            <div className="now-empty">Nessun brano in onda</div>
          )}
          {fading.map((f) => (
            <div key={f.uid} className="now-fading">
              In uscita: {f.track.artist} – {f.track.title}
            </div>
          ))}
          <Meter radio={radio} />
        </div>

        <TitoloParlatoBox />

        <div className="transport" data-sezione="transport" data-titolo="PLAY / AVANTI / STOP">
          <button className="big play" disabled={!!main || !s.queue.length} onClick={() => void engine.play()}>
            ▶ PLAY
          </button>
          <button className="big next" disabled={!s.queue.length} onClick={() => void engine.next()}>
            ⏭ AVANTI
          </button>
          <button className="big stop" disabled={!main} onClick={() => void stop()}>
            ■ STOP
          </button>
          <div className="dj-row">
            <button
              className={`dj-once ${s.dj.once ? 'on' : ''}`}
              disabled={!main || !s.queue.length}
              title="Il prossimo cambio sarà a tempo, come un DJ (una volta sola)"
              onClick={() => engine.setDjOnce(!s.dj.once, djStyle || null)}
            >
              🎧 {s.dj.once ? 'Mix DJ prenotato (annulla)' : 'Mixa il prossimo'}
            </button>
            <select
              className="dj-style"
              title="Tipo di passaggio per il prossimo cambio"
              value={djStyle}
              onChange={(e) => {
                const v = e.target.value as MixStyle | ''
                setDjStyle(v)
                if (s.dj.once) engine.setDjOnce(true, v || null)
              }}
            >
              <option value="">Passaggio automatico</option>
              {MIX_STYLES.map((m) => (
                <option key={m.id} value={m.id} title={m.help}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className={`dj-info ${s.dj.next && !s.dj.next.ok ? 'warn' : ''}`}>
              {s.dj.mixing
                ? 'Mix DJ in corso'
                : s.dj.next
                  ? s.dj.next.text
                  : s.dj.always
                    ? 'Mix DJ acceso nei cambi automatici'
                    : ''}
            </span>
          </div>
        </div>

        <div className="queue" data-sezione="queue" data-titolo="In coda">
          <div className="section-title">
            In coda
            {s.queue.length > 0 && (
              <button className="small" onClick={() => void svuota()}>
                Svuota
              </button>
            )}
          </div>
          {s.queue.length === 0 && (
            <div className="empty">
              {s.mode === 'auto'
                ? 'La coda si riempie da sola…'
                : 'Coda vuota: aggiungi brani dalla ricerca qui a destra o passa in AUTOMATICO.'}
            </div>
          )}
          <ul className="track-list queue-list">
            {s.queue.map((q, i) => (
              <li key={q.uid} className={q.origin === 'event' ? 'event' : ''}>
                {/* in MANUALE la coda non parte da sola: l'orario previsto non avrebbe senso */}
                <div className="t-eta">{s.mode === 'auto' || q.origin === 'event' ? hhmm(q.eta) : ''}</div>
                <div className="t-main">
                  <div className="t-title">{q.track.title}</div>
                  <div className="t-artist">
                    {q.track.artist}
                    {q.track.kind !== 'music' && <span className="tag">{KIND_LABEL[q.track.kind]}</span>}
                    {q.origin === 'event' && <span className="tag event">{q.eventLabel || 'Evento'}</span>}
                    {introSeconds(q.track) > 0 && (
                      <span className="tag intro" title="Durata dell'intro">
                        intro {Math.round(introSeconds(q.track))} s
                      </span>
                    )}
                  </div>
                </div>
                <div className="t-dur">{mmss(q.track.duration)}</div>
                <div className="t-actions">
                  {q.track.id > 0 && <PreviewButton radio={radio} track={q.track} />}
                  <button className="small" disabled={i === 0} onClick={() => engine.move(q.uid, -1)} title="Su">
                    ▲
                  </button>
                  <button
                    className="small"
                    disabled={i === s.queue.length - 1}
                    onClick={() => engine.move(q.uid, 1)}
                    title="Giù"
                  >
                    ▼
                  </button>
                  <button className="small danger" onClick={() => engine.remove(q.uid)} title="Togli dalla coda">
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Riquadri>

      <Riquadri as="section" className="right" chiave="onair-destra" nome="In onda, colonna destra">
        <TrackSearch
          sezione={{ id: 'cerca', titolo: 'Cerca brani' }}
          actions={(t) => (
            <>
              <PreviewButton radio={radio} track={t} />
              <button className="small" title="Metti come prossimo" onClick={() => engine.enqueue(t, 0)}>
                Prossimo
              </button>
              <button className="small primary" title="Aggiungi in fondo alla coda" onClick={() => engine.enqueue(t)}>
                + Coda
              </button>
            </>
          )}
        />
        <Cartwall radio={radio} />
      </Riquadri>
    </div>
  )
}

function Cartwall({ radio }: { radio: Radio }) {
  const [assigning, setAssigning] = useState<number | null>(null)
  const playing = new Set(radio.snapshot.carts.map((c) => c.track.id))

  const assign = async (slot: number, trackId: number | null): Promise<void> => {
    const cw = [...radio.settings.cartwall]
    cw[slot] = trackId
    await radio.saveSettings({ cartwall: cw })
    setAssigning(null)
  }

  return (
    <div className="cartwall" data-sezione="cartwall" data-titolo="Jingle istantanei">
      <div className="section-title">
        Jingle istantanei
        {radio.snapshot.carts.length > 0 && (
          <button className="small danger" onClick={() => radio.engine.stopCarts()}>
            Ferma jingle
          </button>
        )}
      </div>
      <div className="cart-grid">
        {radio.cartTracks.map((t, i) => (
          <div key={i} className={`cart ${t ? '' : 'unassigned'} ${t && playing.has(t.id) ? 'playing' : ''}`}>
            <button className="cart-play" disabled={!t} onClick={() => t && void radio.engine.playCart(t)}>
              <span className="cart-n">{i + 1}</span>
              <span className="cart-name">{t ? t.title : 'vuoto'}</span>
            </button>
            <button className="cart-edit" title="Assegna" onClick={() => setAssigning(i)}>
              ✎
            </button>
          </div>
        ))}
      </div>
      {assigning != null && (
        <div className="modal" onClick={() => setAssigning(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">
              Tasto {assigning + 1}: scegli un jingle
              <button className="small" onClick={() => void assign(assigning, null)}>
                Svuota tasto
              </button>
              <button className="small" onClick={() => setAssigning(null)}>
                Chiudi
              </button>
            </div>
            <TrackSearch
              autoFocus
              actions={(t) => (
                <button className="small primary" onClick={() => void assign(assigning, t.id)}>
                  Assegna
                </button>
              )}
            />
          </div>
        </div>
      )}
    </div>
  )
}
