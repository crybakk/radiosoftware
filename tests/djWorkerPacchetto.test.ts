import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Il thread dell'analisi DJ gira da app.asar.unpacked: anche i pezzi di codice che importa (out/main/chunks, per
 * esempio djAnalysis condiviso con il processo principale) devono stare fuori dall'asar. Con la 0.1.29-0.1.38 non
 * c'erano: il thread non partiva e tutta la libreria risultava "senza ritmo regolare" (niente Mix DJ).
 */
describe('pacchetto della regia', () => {
  it('il thread dell\'analisi DJ e i pezzi che importa sono fuori dall\'asar', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { build: { asarUnpack: string[] } }
    expect(pkg.build.asarUnpack).toContain('out/main/djWorker.js')
    expect(pkg.build.asarUnpack).toContain('out/main/chunks/**')
  })
})
