import { describe, expect, it } from 'vitest'
import { appTitle, ESTERNA_ATTESA_MS, SpokenText, SpokenTitles, spokenTitle, type SpokenContext, type SpokenSong, type SpokenTarget } from './titoloParlato.ts'

const prog = { id: 'p1', title: 'Mattina Insieme', author: 'Anna e Luca' }

describe('spokenTitle', () => {
  it('programma in palinsesto: titolo = programma, artista = conduttore', () => {
    expect(spokenTitle({ program: prog, text: '', radioName: 'Radio Test', slogan: 'La tua radio' })).toEqual({ artist: 'Anna e Luca', title: 'Mattina Insieme' })
  })
  it('testo libero aggiunto al programma', () => {
    expect(spokenTitle({ program: prog, text: ' Ospite: Mario Rossi ', radioName: 'Radio Test', slogan: '' })).toEqual({
      artist: 'Anna e Luca',
      title: 'Mattina Insieme – Ospite: Mario Rossi'
    })
  })
  it('programma senza conduttore: artista = nome della radio', () => {
    expect(spokenTitle({ program: { ...prog, author: '' }, text: '', radioName: 'Radio Test', slogan: '' }).artist).toBe('Radio Test')
  })
  it('senza programma: nome e slogan della radio, o il testo libero', () => {
    expect(spokenTitle({ program: null, text: '', radioName: 'Radio Test', slogan: 'La tua radio' })).toEqual({ artist: 'Radio Test', title: 'La tua radio' })
    expect(spokenTitle({ program: null, text: 'Speciale elezioni', radioName: 'Radio Test', slogan: 'La tua radio' })).toEqual({
      artist: 'Radio Test',
      title: 'Speciale elezioni'
    })
    // niente "Radio Test - Radio Test"
    expect(spokenTitle({ program: null, text: '', radioName: 'Radio Test', slogan: '' })).toEqual({ artist: '', title: 'Radio Test' })
  })
})

describe('SpokenText', () => {
  it('vale solo per il programma in cui è stato scritto', () => {
    const t = new SpokenText()
    t.set('  Ospite:   Mario  ', 'p1')
    expect(t.get('p1')).toBe('Ospite: Mario')
    expect(t.get('p2')).toBe('')
    // finito il programma il testo non torna
    expect(t.get('p1')).toBe('')
  })
  it('taglia i testi troppo lunghi', () => {
    const t = new SpokenText()
    t.set('x'.repeat(500), null)
    expect(t.get(null).length).toBe(120)
  })
})

function setup() {
  const sent: [SpokenTarget, SpokenSong][] = []
  const shown: SpokenSong[] = []
  let current: SpokenSong = { artist: 'Anna e Luca', title: 'Mattina Insieme' }
  const sp = new SpokenTitles({
    compute: () => current,
    send: async (t, s) => (sent.push([t, s]), true),
    show: (s) => void shown.push(s)
  })
  const ctx = (over: Partial<SpokenContext> = {}): SpokenContext => ({ now: 100_000, autonoma: false, studio: true, recognizedUntil: 0, ...over })
  return { sp, sent, shown, ctx, set: (s: SpokenSong) => (current = s) }
}

describe('SpokenTitles', () => {
  it('regia: solo dopo che la regia ha detto "nessun brano", una volta sola finché non cambia', async () => {
    const { sp, sent, shown, ctx, set } = setup()
    await sp.tick(ctx())
    expect(sent).toEqual([])
    sp.setRegia(true)
    await sp.tick(ctx())
    await sp.tick(ctx())
    expect(sent).toEqual([['studio', { artist: 'Anna e Luca', title: 'Mattina Insieme' }]])
    expect(shown.length).toBe(2)
    // cambia il programma (o il testo libero): si rimanda
    set({ artist: 'Radio Test', title: 'La tua radio' })
    await sp.tick(ctx())
    expect(sent.at(-1)).toEqual(['studio', { artist: 'Radio Test', title: 'La tua radio' }])
    // parte un brano: niente titolo parlato
    sp.setRegia(false)
    await sp.tick(ctx())
    expect(sent.length).toBe(2)
    // brano finito di nuovo: si rimanda anche se il titolo è lo stesso di prima
    sp.setRegia(true)
    await sp.tick(ctx())
    expect(sent.length).toBe(3)
  })
  it('regia non collegata (riserva) o diretta autonoma: niente titolo parlato', async () => {
    const { sp, sent, ctx } = setup()
    sp.setRegia(true)
    await sp.tick(ctx({ studio: false }))
    await sp.tick(ctx({ autonoma: true }))
    expect(sent).toEqual([])
  })
  it('esterna senza titolo dall\'app: titolo parlato dopo l\'attesa, tranne durante un brano riconosciuto', async () => {
    const { sp, sent, ctx } = setup()
    sp.esternaConnected(100_000)
    await sp.tick(ctx({ now: 100_000 + ESTERNA_ATTESA_MS - 1 }))
    expect(sent).toEqual([])
    await sp.tick(ctx({ now: 100_000 + ESTERNA_ATTESA_MS, recognizedUntil: 200_000 }))
    expect(sent).toEqual([])
    await sp.tick(ctx({ now: 200_000, recognizedUntil: 200_000 }))
    expect(sent).toEqual([['esterna', { artist: 'Anna e Luca', title: 'Mattina Insieme' }]])
  })
  it('esterna con titolo dall\'app: vale quello', async () => {
    const { sp, sent, ctx } = setup()
    sp.setRegia(true)
    sp.esternaConnected(100_000)
    sp.esternaAppTitle()
    await sp.tick(ctx({ now: 200_000 }))
    expect(sent).toEqual([])
    // finita l'esterna si torna alla regia (che non suona niente)
    sp.esternaDisconnected()
    await sp.tick(ctx({ now: 200_000 }))
    expect(sent).toEqual([['studio', { artist: 'Anna e Luca', title: 'Mattina Insieme' }]])
  })
  it('se Liquidsoap non risponde si riprova al giro dopo', async () => {
    let ok = false
    const sent: SpokenTarget[] = []
    const sp = new SpokenTitles({ compute: () => ({ artist: 'a', title: 't' }), send: async (t) => (sent.push(t), ok), show: () => {} })
    sp.setRegia(true)
    const c = { now: 1, autonoma: false, studio: true, recognizedUntil: 0 }
    await sp.tick(c)
    ok = true
    await sp.tick(c)
    await sp.tick(c)
    expect(sent).toEqual(['studio', 'studio'])
  })
})

describe('appTitle', () => {
  it('legge artista e titolo, anche da "song"', () => {
    expect(appTitle({ artist: 'A', title: 'T' })).toEqual({ artist: 'A', title: 'T' })
    expect(appTitle({ song: 'Lucio Dalla - Caruso' })).toEqual({ artist: 'Lucio Dalla', title: 'Caruso' })
    expect(appTitle({ song: 'Speciale sport' })).toEqual({ artist: '', title: 'Speciale sport' })
    expect(appTitle({ artist: '', title: '', song: ' ' })).toBeNull()
  })
})
