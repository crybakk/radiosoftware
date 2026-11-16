import { describe, expect, it } from 'vitest'
import { Alarms } from './alarms.ts'
import { DiskGuard, freeMB } from './disco.ts'

describe('spazio sul disco', () => {
  it("sotto la soglia rifiuta con il motivo e apre l'allarme una volta; lo chiude quando lo spazio torna", () => {
    const free: Record<string, number> = { '/data': 5000, '/musica': 5000 }
    const sent: { text: string; open: boolean }[] = []
    const alarms = new Alarms({ disconnectedSeconds: 30, heartbeatSeconds: 90, flapCount: 3 }, (text, key, open) => key === 'disco_pieno' && sent.push({ text, open }))
    const g = new DiskGuard({ dirs: ['/data', '/musica'], minFreeMB: 2048, free: (d) => free[d], onAlarm: (full, detail) => alarms.setDiskFull(full, detail) })
    expect(g.check()).toBeNull()
    free['/musica'] = 100.7
    expect(g.check('/musica')).toMatch(/100 MB liberi, ne servono almeno 2048/)
    expect(g.check('/musica')).not.toBeNull()
    // un controllo sull'altra cartella non chiude l'allarme
    expect(g.check('/data')).toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ open: true })
    expect(sent[0].text).toContain('/musica')
    expect(alarms.status().alarms.map((a) => a.key)).toEqual(['disco_pieno'])
    free['/musica'] = 3000
    expect(g.check()).toBeNull()
    expect(sent.at(-1)).toMatchObject({ open: false })
    expect(alarms.status().alarms).toEqual([])
  })

  it('cartella che non si legge: si lascia passare', () => {
    expect(freeMB('/non/esiste/proprio')).toBeNull()
    expect(freeMB('.')).toBeGreaterThan(0)
    const g = new DiskGuard({ dirs: ['/x'], minFreeMB: 2048, free: () => null, onAlarm: () => {} })
    expect(g.check()).toBeNull()
  })
})
