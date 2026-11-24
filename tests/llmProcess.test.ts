import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { crashMessage, processEngine, type ChildLike, type WorkerReply, type WorkerRequest } from '../src/main/llmProcess'

/** Processo finto: risponde come llmWorker, oppure "cade" come farebbe llama.cpp senza memoria. */
class FakeChild extends EventEmitter implements ChildLike {
  sent: WorkerRequest[] = []
  killed = false
  constructor(private behave: (r: WorkerRequest, c: FakeChild) => void, ready = true) {
    super()
    if (ready) queueMicrotask(() => this.emit('message', { id: 0, ready: true } satisfies WorkerReply))
  }
  postMessage(m: WorkerRequest): void {
    this.sent.push(m)
    queueMicrotask(() => this.behave(m, this))
  }
  kill(): void {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 1))
  }
  lastOutput(): string {
    return 'GGML_ASSERT: memoria finita'
  }
}

const args = { modelPath: 'm.gguf', system: 's', user: 'u', schema: {} }

describe('AI in un processo separato', () => {
  it('restituisce la risposta e chiude il processo', async () => {
    const child = new FakeChild((r, c) => c.emit('message', { id: r.id, result: '{"slots":[]}' }))
    const engine = processEngine({ spawn: () => child })
    expect(await engine.complete(args)).toBe('{"slots":[]}')
    expect(child.sent[0]).toMatchObject({ type: 'complete', user: 'u' })
    expect(child.killed).toBe(true)
  })

  it('se il motore cade la regia riceve un errore, non si chiude', async () => {
    const logs: string[] = []
    const child = new FakeChild((_r, c) => c.emit('exit', -1073741819))
    const engine = processEngine({ spawn: () => child, log: (s) => logs.push(s) })
    await expect(engine.complete(args)).rejects.toThrow(crashMessage(-1073741819))
    expect(logs.join('\n')).toContain('GGML_ASSERT')
  })

  it('un errore del motore arriva così com\'è', async () => {
    const child = new FakeChild((r, c) => c.emit('message', { id: r.id, error: 'il modello non si apre' }))
    await expect(processEngine({ spawn: () => child }).complete(args)).rejects.toThrow('il modello non si apre')
  })

  it('interrompere chiude il processo', async () => {
    const child = new FakeChild(() => {})
    const ac = new AbortController()
    const p = processEngine({ spawn: () => child }).complete({ ...args, signal: ac.signal })
    await new Promise((r) => setTimeout(r, 5))
    ac.abort()
    await expect(p).rejects.toThrow('interrotto')
    expect(child.killed).toBe(true)
  })

  it('se il processo non parte usa il motore nella regia', async () => {
    const logs: string[] = []
    const child = new FakeChild(() => {}, false)
    queueMicrotask(() => child.emit('exit', 1))
    const engine = processEngine({
      spawn: () => child,
      fallback: { complete: async () => 'dal motore interno' },
      log: (s) => logs.push(s)
    })
    expect(await engine.complete(args)).toBe('dal motore interno')
    expect(logs[0]).toContain('non partito')
  })

  it('sessione aperta: tante domande, poi chiusura; dopo un crash le domande falliscono subito', async () => {
    let n = 0
    const child = new FakeChild((r, c) => {
      if (r.type === 'ask' && ++n === 2) return void c.emit('exit', 3)
      c.emit('message', { id: r.id, result: r.type === 'ask' ? `risposta ${n}` : '' })
    })
    const s = await processEngine({ spawn: () => child }).open!({ modelPath: 'm', system: 's', schema: {} })
    expect(await s.ask('a')).toBe('risposta 1')
    await expect(s.ask('b')).rejects.toThrow('codice 3')
    await expect(s.ask('c')).rejects.toThrow('codice 3')
    await s.close()
  })
})

describe('grammatica JSON compatta', () => {
  it('toglie a capo e rientri, lascia il resto uguale', async () => {
    const { compactJsonGrammar } = await import('../src/main/llm')
    const g = [
      'root ::= "{" whitespace-b-1-4-rule "\\"slots\\"" ":" [ ]? rule5 whitespace-b-0-4-rule "}" "\\n\\n\\n\\n" [\\n]*',
      'comma-whitespace-b-3-4-rule ::= "," ([\\n] (" "{12} | "\\t"{3}) | [ ]?)',
      'whitespace-b-1-4-rule ::= [\\n] ("    " | "\\t") | [ ]?',
      'whitespace-b-0-4-rule ::= [\\n] | [ ]?',
      'null-rule ::= "null"'
    ].join('\n')
    expect(compactJsonGrammar(g).split('\n')).toEqual([
      'root ::= "{" whitespace-b-1-4-rule "\\"slots\\"" ":" [ ]? rule5 whitespace-b-0-4-rule "}" "\\n\\n\\n\\n" [\\n]*',
      'comma-whitespace-b-3-4-rule ::= "," [ ]?',
      'whitespace-b-1-4-rule ::= [ ]?',
      'whitespace-b-0-4-rule ::= [ ]?',
      'null-rule ::= "null"'
    ])
  })
})

describe('memoria per l\'AI', () => {
  it('contesto grande quanto serve, tra 2048 e 8192', async () => {
    const { planContextSize } = await import('../src/main/llm')
    // il palinsesto di una giornata intera: ~2000 pezzi di istruzioni e domanda
    expect(planContextSize(2000)).toBe(5376)
    expect(planContextSize(10)).toBe(3328)
    expect(planContextSize(9000)).toBe(8192)
  })

  it('con poca memoria libera un messaggio chiaro invece di cadere', async () => {
    const { checkMemory, memoryNeeded } = await import('../src/main/llm')
    const need = memoryNeeded(2.5e9, 5376)
    expect(need / 1e9).toBeCloseTo(3.7, 1)
    expect(() => checkMemory(need, 2.1e9)).toThrow('circa 3,7 GB liberi e adesso ce ne sono 2,1')
    expect(() => checkMemory(need, 4e9)).not.toThrow()
  })
})
