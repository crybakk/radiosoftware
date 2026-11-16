import { describe, expect, it } from 'vitest'
import { csvField, csvText, logToCsv } from '../src/core/csv'
import { siaeCsv } from '../src/core/siae'
import { cleanLabelField } from '../ponte/controllo/src/riconoscimento'

describe('CSV e formule di Excel', () => {
  it('il registro mette un apostrofo davanti ai testi che sembrano formule', () => {
    expect(csvText('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    expect(csvText('@SUM(1)')).toBe("'@SUM(1)")
    expect(csvText('Caruso')).toBe('Caruso')
    const csv = logToCsv([{ startedAt: '2026-11-16T10:00:00Z', playedSeconds: 60, kind: 'music', title: '=1+1', artist: '-Band', composer: '', publisher: '', isrc: '', iswc: '', siaeCode: '', source: 'regia' } as never])
    expect(csv).toContain(";'=1+1;'-Band;")
  })

  it('il CSV della SIAE resta identico', () => {
    expect(csvField('=1+1')).toBe('=1+1')
    expect(siaeCsv([{ title: '=1+1', authors: 'A', publisher: '', performer: 'B', uses: 1, siaeCode: '', iswc: '', isrc: '' } as never])).toContain('=1+1;A;')
  })

  it('le etichette scritte a mano perdono = + - @ iniziali', () => {
    expect(cleanLabelField('  =HYPERLINK("x")')).toBe('HYPERLINK("x")')
    expect(cleanLabelField('@-+ Mina')).toBe('Mina')
    expect(cleanLabelField('AC-DC')).toBe('AC-DC')
  })
})
