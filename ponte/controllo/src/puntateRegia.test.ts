import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CollegamentoStudio } from './collegamentoStudio.ts'
import { Programs, type Episode } from './programmi.ts'
import { leggiFine, PuntateRegia, segni, type FineRegia } from './puntateRegia.ts'
import { hms, leggiTaglio, leggiTempo, pianoCopia, RevisioneTelegram } from './revisioneTelegram.ts'

const T0 = new Date('2026-11-23T21:00:00').getTime()
const MIN = 60_000

function setup(collegata = true) {
  const dir = mkdtempSync(join(tmpdir(), 'preg-'))
  let now = T0 - 10 * MIN
  const programs = new Programs(dir, () => now)
  const p = programs.saveProgram({ title: 'Mattina', slots: [], record: true, studio: true })
  const studio = new CollegamentoStudio(null, () => now)
  studio.collegata(collegata)
  const published: { id: string; from: number; to: number }[] = []
  const review: Episode[] = []
  const regia = new PuntateRegia({
    programs,
    studio,
    publish: async (id, m) => {
      published.push({ id, from: m.from, to: m.to })
      return programs.published(id, { title: m.title, description: m.description, length: m.to - m.from })
    },
    daRivedere: (e) => review.push(e),
    seconds: async () => 3600,
    log: () => {}
  })
  return { dir, programs, p, studio, regia, published, review, setNow: (t: number) => (now = t) }
}

const fine = (x: Partial<FineRegia> = {}): FineRegia => ({
  programId: 'mattina',
  startedAt: T0,
  endedAt: T0 + 60 * MIN,
  startMark: T0 + 2 * MIN,
  endMark: T0 + 58 * MIN,
  startAuto: false,
  endAuto: false,
  ...x
})

describe('fine della registrazione in regia', () => {
  it('nessuna interruzione e ponte che sta ancora registrando: si pubblica quella del ponte appena finisce', async () => {
    const s = setup()
    const ep = s.programs.startRecording('mattina', T0 - 2 * MIN)
    s.setNow(T0 + 60 * MIN)
    const r = await s.regia.fine(fine())
    expect(r).toEqual({ usa: 'ponte', interruzioni: [], revisione: false })
    writeFileSync(s.programs.rawFile(ep.id), Buffer.alloc(20_000))
    const draft = s.programs.endRecording(ep.id, T0 + 62 * MIN, 64 * 60)!
    expect(s.regia.dopoRegistrazione(draft)).toBe(true)
    await new Promise((ok) => setTimeout(ok, 10))
    expect(s.published).toEqual([{ id: ep.id, from: 4 * 60, to: 60 * 60 }])
    expect(s.review).toEqual([])
  })

  it('inizio e fine automatici senza segni: si tiene il ponte ma da rivedere', async () => {
    const s = setup()
    const ep = s.programs.startRecording('mattina', T0 - 2 * MIN)
    writeFileSync(s.programs.rawFile(ep.id), Buffer.alloc(20_000))
    s.programs.endRecording(ep.id, T0 + 62 * MIN, 64 * 60)
    s.setNow(T0 + 62 * MIN)
    const r = await s.regia.fine(fine({ startMark: null, endMark: null, startAuto: true, endAuto: true }))
    expect(r.usa).toBe('ponte')
    expect(r.revisione).toBe(true)
    expect(s.published).toEqual([])
    expect(s.review).toHaveLength(1)
    expect(s.review[0].reason).toMatch(/automatici/)
    expect(s.review[0].cut).toEqual({ from: 120, to: 62 * 60 })
  })

  it('interruzione: serve il file della regia, che sostituisce il ponte e resta da rivedere con i segni', async () => {
    const s = setup()
    const ep = s.programs.startRecording('mattina', T0 - 2 * MIN)
    s.setNow(T0 + 20 * MIN)
    s.studio.collegata(false)
    s.setNow(T0 + 20 * MIN + 8000)
    s.studio.collegata(true)
    s.setNow(T0 + 60 * MIN)
    const f = fine()
    const r = await s.regia.fine(f)
    expect(r.usa).toBe('regia')
    expect(r.interruzioni).toHaveLength(1)
    // la regia manda il file
    const id = s.regia.nuovoId()
    writeFileSync(s.programs.rawFile(id), Buffer.alloc(20_000))
    const e = await s.regia.ricevuto(id, leggiFine({ ...f, startAuto: '0', endAuto: '0' }))
    expect(e.status).toBe('bozza')
    expect(e.source).toBe('regia')
    expect(e.stereotool).toBe(true)
    expect(e.cut).toEqual({ from: 120, to: 58 * 60 })
    expect(e.markers?.map((m) => [m.kind, m.at, m.length ?? null])).toEqual([
      ['inizio', 120, null],
      ['interruzione', 1200, 8],
      ['fine', 3480, null]
    ])
    expect(s.review.map((x) => x.id)).toEqual([id])
    // la registrazione del ponte ancora in corso si toglierà appena finisce
    expect(s.programs.episode(ep.id)?.replaced).toBe(true)
    writeFileSync(s.programs.rawFile(ep.id), Buffer.alloc(20_000))
    const d = s.programs.endRecording(ep.id, T0 + 62 * MIN, 3700)!
    expect(s.regia.dopoRegistrazione(d)).toBe(true)
    expect(s.programs.episode(ep.id)).toBeUndefined()
  })

  it('senza registrazione del ponte e senza interruzioni: il file della regia si pubblica subito', async () => {
    const s = setup()
    s.setNow(T0 + 60 * MIN)
    const f = fine()
    expect((await s.regia.fine(f)).usa).toBe('regia')
    const id = s.regia.nuovoId()
    writeFileSync(s.programs.rawFile(id), Buffer.alloc(20_000))
    await s.regia.ricevuto(id, f)
    expect(s.published).toEqual([{ id, from: 120, to: 58 * 60 }])
  })

  it('dati non validi', () => {
    expect(() => leggiFine({ programId: 'x', startedAt: 10, endedAt: 5 })).toThrow()
    expect(() => leggiFine({ startedAt: 1, endedAt: 5 })).toThrow()
  })

  it('segni: inizio a mano senza segno = inizio della registrazione', () => {
    const m = segni(fine({ startMark: null, endMark: null, startAuto: false, endAuto: true }), T0, [])
    expect(m).toEqual([{ at: 0, kind: 'inizio' }])
  })
})

describe('revisione da Telegram', () => {
  it('legge tempi e tagli', () => {
    expect(leggiTempo('1:02:03')).toBe(3723)
    expect(leggiTempo('2:10')).toBe(130)
    expect(leggiTempo('x')).toBeNaN()
    expect(leggiTaglio('inizio 2:10 fine 1:01:30')).toEqual({ from: 130, to: 3690 })
    expect(leggiTaglio('Fine: 59:00')).toEqual({ to: 3540 })
    expect(leggiTaglio('ciao')).toBeNull()
    expect(hms(3723)).toBe('1:02:03')
  })

  it('copia intera nel limite di Telegram, divisa in parti se lunghissima', () => {
    const un = pianoCopia(3600)
    expect(un.kbps).toBe(96)
    expect(un.parti).toHaveLength(1)
    const tre = pianoCopia(3 * 3600)
    expect(tre.kbps).toBeLessThan(96)
    expect(tre.parti).toHaveLength(1)
    const otto = pianoCopia(8 * 3600)
    expect(otto.kbps).toBe(32)
    expect(otto.parti.length).toBeGreaterThan(1)
    for (const p of otto.parti) expect((p.length * otto.kbps * 1000) / 8).toBeLessThanOrEqual(45 * 1024 * 1024)
  })

  it('messaggio, cambio del taglio con una risposta e pubblicazione col pulsante', async () => {
    const s = setup()
    const id = s.regia.nuovoId()
    writeFileSync(s.programs.rawFile(id), Buffer.alloc(20_000))
    const e = s.programs.addStudioEpisode({ id, programId: 'mattina', from: T0, to: T0 + 60 * MIN, length: 3600, markers: [{ at: 1200, kind: 'interruzione', length: 8 }], cut: { from: 0, to: 3600 }, reason: '1 interruzione' })
    const calls: [string, unknown][] = []
    const bot = { api: async (m: string, b: unknown) => (calls.push([m, b]), { message_id: 77 }) }
    const rev = new RevisioneTelegram({ bot, programs: s.programs, stateFile: join(s.dir, 'rev.json'), tmpDir: s.dir, publish: async (i, m) => s.programs.published(i, { ...m, length: m.to - m.from }), nice: '', ffmpeg: 'non-esiste' })
    // senza ffmpeg le copie audio non partono, ma il messaggio con i pulsanti sì
    await rev.invia(e).catch(() => {})
    expect(calls[0][0]).toBe('sendMessage')
    expect(String((calls[0][1] as { text: string }).text)).toMatch(/0:20:00 interruzione di 8 s/)
    const replies: string[] = []
    expect(await rev.reply(77, 'inizio 1:00 fine 59:00', { by: 'Telegram: @a', messageId: 78, reply: async (t) => replies.push(t) })).toBe(true)
    expect(s.programs.episode(id)?.cut).toEqual({ from: 60, to: 3540 })
    expect(await rev.reply(99, 'inizio 1:00', { by: 'x', messageId: 79, reply: async () => {} })).toBe(false)
    const answers: string[] = []
    expect(await rev.callback(`rev:pub:${id}`, { by: 'Telegram: @a', messageId: 77, answer: async (t) => answers.push(t ?? '') })).toBe(true)
    expect(s.programs.episode(id)?.status).toBe('pubblicata')
    expect(await rev.callback('altro', { by: 'x', answer: async () => {} })).toBe(false)
  })
})

describe('pubblicazione con Stereo Tool', () => {
  it('resta "in elaborazione" e si pubblica da sola alla fine; se fallisce torna da rivedere', async () => {
    const { configuraElaborazione, publishEpisode } = await import('./puntate.ts')
    const s = setup()
    const make = () => {
      const id = s.regia.nuovoId()
      writeFileSync(s.programs.rawFile(id), Buffer.alloc(20_000))
      return s.programs.addStudioEpisode({ id, programId: 'mattina', from: T0, to: T0 + 60 * MIN, length: 3600, markers: [], cut: { from: 0, to: 3600 } })
    }
    let finish: (() => void) | null = null
    let fail = false
    const msgs: string[] = []
    const done: (Episode | null)[] = []
    configuraElaborazione({
      elabora: (_i, out, from, to) =>
        new Promise((ok, ko) => {
          expect([from, to]).toEqual([60, 3000])
          finish = () => {
            if (fail) return ko(new Error('licenza non valida'))
            writeFileSync(out, Buffer.alloc(30_000))
            ok()
          }
        }),
      avvisa: (t) => msgs.push(t),
      fatto: (e) => done.push(e)
    })
    try {
      const a = make()
      const r = await publishEpisode(s.programs, a.id, { from: 60, to: 3000, title: 'Puntata 1', description: '' }, { seconds: async () => 2940 })
      expect(r.status).toBe('elaborazione')
      await expect(publishEpisode(s.programs, a.id, { from: 60, to: 3000, title: '', description: '' })).rejects.toThrow()
      finish!()
      await new Promise((ok) => setTimeout(ok, 20))
      expect(s.programs.episode(a.id)?.status).toBe('pubblicata')
      expect(s.programs.episode(a.id)?.length).toBe(2940)
      expect(msgs[0]).toMatch(/pubblicata/)

      fail = true
      const b = make()
      await publishEpisode(s.programs, b.id, { from: 60, to: 3000, title: 'Puntata 2', description: '' })
      finish!()
      await new Promise((ok) => setTimeout(ok, 20))
      expect(s.programs.episode(b.id)?.status).toBe('bozza')
      expect(s.programs.episode(b.id)?.reason).toMatch(/licenza non valida/)
      expect(done).toHaveLength(2)
    } finally {
      configuraElaborazione(null)
    }
  })
})
