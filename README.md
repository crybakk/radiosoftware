# Radio Regia

Software di regia radiofonica per webradio: playout automatico, diretta remota con microfono e ospiti, controllo del player da remoto anche con il PC di regia dietro NAT 4G, streaming verso AzuraCast e servizi terzi.

L'architettura completa è in [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md).

## Stato

**Fase 1 – regia base** (in prova):

- Libreria: cartelle per tipo (musica, jingle, notiziari, programmi, spot), lettura dei tag ID3 (titolo, interprete, autori, editore, ISRC), aggiornamento incrementale.
- Analisi automatica in background con ffmpeg: volume EBU R128 per livellare i brani, inizio e fine dell'audio utile, punto di mix per la dissolvenza.
- Messa in onda: modalità automatica e manuale, coda modificabile, dissolvenze, PLAY / AVANTI / STOP, 12 jingle istantanei, VU meter.
- Rotazione automatica con separazione artista e brano e un jingle ogni N brani.
- Eventi a orario fisso (anche "ogni ora"), all'orario esatto o dopo il brano in onda.
- Preascolto in cuffia su una scheda audio separata; scelta dell'uscita in onda (per esempio il RodeCaster Duo).
- Registro di trasmissione con esportazione CSV (il report SIAE nel formato del fac simile arriva con la fase 7).

## Installazione su Windows

Ogni push compila l'installer in GitHub Actions: apri la scheda **Actions** del repository, l'ultima esecuzione di "Test e build Windows", e scarica l'artefatto **RadioRegia-Setup-Windows**.

## Sviluppo

```bash
npm install
npm run dev        # avvia l'app in sviluppo
npm test           # test automatici
npm run typecheck
npm run dist:win   # installer Windows (da eseguire su Windows)
```

Struttura:

- `src/core/` – logica indipendente da Electron (database, scansione, analisi, rotazione, eventi, motore di messa in onda), coperta dai test in `tests/`.
- `src/main/` – processo principale Electron (database, file audio, finestre di dialogo).
- `src/renderer/` – interfaccia React e motore audio Web Audio.
