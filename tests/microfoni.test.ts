import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// Il pannello web è uno script classico: lo carichiamo come nel browser, ma senza DOM
type Scelta = { device: string | null; channel: string }
type Piano = {
  aperture: { device: string; stereo: boolean; constraints: Record<string, unknown> }[]
  usati: { mic: number; device: string; channel: string }[]
  doppio: boolean
  senzaEco: boolean
}
const modulo = { exports: {} as { pianoCattura: (s: Scelta[], cuffie: boolean) => Piano } }
runInNewContext(readFileSync(join(__dirname, '..', 'ponte', 'controllo', 'pannello', 'microfoni.js'), 'utf8'), { module: modulo })
const { pianoCattura } = modulo.exports

describe('due microfoni nel pannello', () => {
  it('un solo microfono: come prima, mono, elaborazione solo senza cuffie', () => {
    const p = pianoCattura([{ device: '', channel: 'tutti' }, { device: null, channel: 'tutti' }], true)
    expect(p.aperture).toHaveLength(1)
    expect(p.usati).toEqual([{ mic: 0, device: '', channel: 'tutti' }])
    expect(p.aperture[0].constraints).toMatchObject({ deviceId: undefined, echoCancellation: false, channelCount: 1 })
    const senza = pianoCattura([{ device: '', channel: 'tutti' }, { device: null, channel: 'tutti' }], false)
    expect(senza.aperture[0].constraints).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
    expect(senza.senzaEco).toBe(false)
  })

  it('due microfoni USB diversi: due ingressi aperti', () => {
    const p = pianoCattura([{ device: 'a', channel: 'tutti' }, { device: 'b', channel: 'tutti' }], true)
    expect(p.aperture.map((a) => a.device)).toEqual(['a', 'b'])
    expect(p.aperture[0].constraints.deviceId).toEqual({ exact: 'a' })
    expect(p.usati.map((u) => u.mic)).toEqual([0, 1])
    expect(p.doppio).toBe(false)
  })

  it('scheda audio a 2 ingressi: aperta una volta sola, in stereo e senza elaborazione', () => {
    const p = pianoCattura([{ device: 'sk', channel: 'c1' }, { device: 'sk', channel: 'c2' }], false)
    expect(p.aperture).toHaveLength(1)
    expect(p.aperture[0].constraints).toMatchObject({ channelCount: { ideal: 2 }, echoCancellation: false })
    expect(p.usati.map((u) => u.channel)).toEqual(['c1', 'c2'])
    expect(p.doppio).toBe(false)
    expect(p.senzaEco).toBe(true)
  })

  it('stesso ingresso e stesso canale due volte: segnalato', () => {
    expect(pianoCattura([{ device: 'a', channel: 'tutti' }, { device: 'a', channel: 'tutti' }], true).doppio).toBe(true)
  })

  it('canale sconosciuto diventa tutto l\'ingresso', () => {
    const p = pianoCattura([{ device: 'a', channel: 'boh' }], true)
    expect(p.usati[0].channel).toBe('tutti')
    expect(p.aperture[0].stereo).toBe(false)
  })
})
