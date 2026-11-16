/**
 * File di stato JSON del ponte (programmi, link degli ospiti, utenti, bot Telegram...). Se un file c'è
 * ma non si legge (rovinato da uno spegnimento, modificato a mano male) si riparte senza, ma prima lo
 * si copia da parte come "<nome>.rovinato-<data>": al primo salvataggio verrebbe sovrascritto e i dati
 * andrebbero persi per sempre.
 */
import { copyFileSync, renameSync } from 'node:fs'

/**
 * Copia da parte il file rovinato e lo scrive nel log. Restituisce il nome della copia (null se non riesce).
 * Con `move` il file si sposta invece di copiarlo (per i file che nessuno riscrive: non si copierebbe a ogni avvio).
 */
export function setAsideBroken(file: string, err: unknown, log: (s: string) => void = (s) => console.error(s), move = false): string | null {
  const why = err instanceof Error ? err.message : String(err)
  const dest = `${file}.rovinato-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    if (move) renameSync(file, dest)
    else copyFileSync(file, dest)
    log(`[stato] ${file} non leggibile (${why}): ${move ? 'spostato' : 'copiato'} in ${dest}, si riparte senza`)
    return dest
  } catch (e) {
    log(`[stato] ${file} non leggibile (${why}) e non copiato da parte: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
