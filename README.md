# Radio Regia

Software di regia radiofonica per webradio: playout automatico, diretta remota con microfono e ospiti, controllo del player da remoto anche con il PC di regia dietro NAT 4G, streaming verso AzuraCast e servizi terzi.

**Guida d'uso:** [docs/GUIDA.md](docs/GUIDA.md) (aggiornata a ogni nuova funzione).

L'architettura completa è in [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md).

## Stato

**Fase 1 – regia base** (in prova):

- Libreria: cartelle per tipo (musica, jingle, notiziari, programmi, spot), lettura dei tag ID3 (titolo, interprete, autori, editore, ISRC), aggiornamento incrementale.
- Analisi automatica in background con ffmpeg: volume EBU R128 per livellare i brani, inizio e fine dell'audio utile, punto di mix per la dissolvenza.
- Messa in onda: modalità automatica e manuale, coda modificabile, dissolvenze, PLAY / AVANTI / STOP, 12 jingle istantanei, VU meter.
- Rotazione automatica con separazione artista e brano e un jingle ogni N brani.
- Eventi programmati come sequenza di azioni: brano, brano casuale (per tipo, genere o cartella), playlist M3U/PLS o cartella, flusso esterno per N minuti, automatico/manuale, svuota coda, ferma tutto, profilo di rotazione (generi, anni, separazioni), comando esterno. Una volta al giorno, ogni ora o ogni N minuti, con giorni, date di validità e partenza dopo il brano, con tolleranza o subito.
- Preascolto in cuffia su una scheda audio separata; scelta dell'uscita in onda (per esempio il RodeCaster Duo).
- Registro di trasmissione con esportazione CSV (il report SIAE nel formato del fac simile arriva con la fase 7).

**Fase 2 – ponte e collegamento** (in prova):

- Ponte sul server di AzuraCast (Docker): riceve il programma dalla regia via SRT, cifrato e tollerante ai buchi del 4G, lo passa nel processore audio e lo manda ad AzuraCast come DJ. Se la regia cade, AzuraCast torna alla sua AutoDJ.
- Allarmi via Telegram e/o email: regia scollegata o muta, silenzio, collegamento instabile, errori verso AzuraCast.
- Regia: scheda Collegamento con stato, riconnessione automatica, titoli in onda ad AzuraCast, backup giornaliero del database sul ponte e ripristino.
- Guida di installazione: [ponte/README.md](ponte/README.md).

**Fase 3 – controllo remoto** (in prova):

- Pannello web servito dal ponte, per telefono, tablet e computer: in onda, PLAY/AVANTI/STOP, automatico/manuale, coda, ricerca, jingle.
- La regia apre lei il canale verso il ponte (funziona dietro il NAT del 4G) e si ricollega da sola.
- Utenti con ruoli (amministratore, conduttore, ospite), accesso con password, HTTPS con il certificato di AzuraCast.

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
