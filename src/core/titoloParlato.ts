/**
 * Titolo parlato dal lato regia: dopo 5 secondi senza brani in onda la regia lo dice al ponte, che manda
 * come titolo il programma in corso e il conduttore (o il nome della radio). Scelte di cristian, 24/11/2026.
 * I jingle nel lettore principale contano come brani (non cambiano il titolo, come prima).
 */

/** Secondi senza brani prima del titolo parlato. */
export const PARLATO_ATTESA_MS = 5000

export interface Timers {
  set: (cb: () => void, ms: number) => unknown
  clear: (t: unknown) => void
}

const realTimers: Timers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
}

/** Decide quando dire al ponte che non suona niente. */
export class SpokenTrigger {
  private timer: unknown = null
  private sent = false

  constructor(
    private fire: () => Promise<boolean>,
    private delayMs = PARLATO_ATTESA_MS,
    private timers: Timers = realTimers
  ) {}

  /**
   * Da chiamare a ogni cambiamento dello stato della regia e a ogni segnale di vita (così, se il ponte non
   * rispondeva, si riprova).
   */
  update(onAir: boolean): void {
    if (onAir) {
      this.cancel()
      this.sent = false
      return
    }
    if (this.sent || this.timer !== null) return
    this.timer = this.timers.set(() => {
      this.timer = null
      this.sent = true
      void this.fire()
        .catch(() => false)
        .then((ok) => {
          if (!ok) this.sent = false
        })
    }, this.delayMs)
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
