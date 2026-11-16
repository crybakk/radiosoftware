# Radio Regia

Software di regia radiofonica per webradio: playout automatico, diretta remota con microfono e ospiti, controllo del player da remoto anche con il PC di regia dietro NAT 4G, streaming con Icecast proprio, Icecast secondario, YouTube e Facebook.

**Guida d'uso:** [docs/GUIDA.md](docs/GUIDA.md), con gli screenshot (aggiornata a ogni nuova funzione). Si apre anche nella regia (scheda **Guida**) e nel pannello (menu ☰ → **📖 Guida**).

L'architettura completa è in [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md).

## Stato

**Fase 1 – regia base** (in prova):

- Libreria: cartelle per tipo (musica, jingle, notiziari, programmi, spot), lettura dei tag ID3 (titolo, interprete, autori, editore, ISRC), aggiornamento incrementale.
- Analisi automatica in background con ffmpeg: volume EBU R128 per livellare i brani, inizio e fine dell'audio utile, punto di mix per la dissolvenza.
- Messa in onda: modalità automatica e manuale, coda modificabile, dissolvenze, PLAY / AVANTI / STOP, 12 jingle istantanei, VU meter.
- Rotazione automatica con separazione artista e brano e un jingle ogni N brani.
- Eventi programmati come sequenza di azioni: brano, brano casuale (per tipo, genere o cartella), playlist M3U/PLS o cartella, flusso esterno per N minuti, automatico/manuale, svuota coda, ferma tutto, profilo di rotazione (generi, anni, separazioni), comando esterno. Una volta al giorno, ogni ora o ogni N minuti, con giorni, date di validità e partenza dopo il brano, con tolleranza o subito.
- Preascolto in cuffia su una scheda audio separata; scelta dell'uscita in onda (per esempio il RodeCaster Duo).
- Registro di trasmissione con esportazione CSV.

**Fase 2 – ponte e collegamento** (in prova):

- Ponte sul server (Docker): riceve il programma dalla regia via SRT, cifrato e tollerante ai buchi del 4G, lo passa nel processore audio e lo manda in onda (dalla fase 6 all'Icecast principale; prima ad AzuraCast).
- Allarmi via Telegram e/o email: regia scollegata o muta, silenzio, collegamento instabile, errori verso le uscite.
- Regia: scheda Collegamento con stato, riconnessione automatica, titoli in onda, backup giornaliero del database sul ponte e ripristino.
- Guida di installazione: [ponte/README.md](ponte/README.md).

**Fase 3 – controllo remoto** (in prova):

- Pannello web servito dal ponte, per telefono, tablet e computer: in onda, PLAY/AVANTI/STOP, automatico/manuale, coda, ricerca, jingle.
- La regia apre lei il canale verso il ponte (funziona dietro il NAT del 4G) e si ricollega da sola.
- Utenti con ruoli (amministratore, conduttore, ospite), accesso con password, HTTPS (dalla fase 6 con Caddy).

**Fasi 4 e 5 – microfono, diretta autonoma, ospiti** (in prova):

- Microfono dal pannello (WebRTC) con ritorno in cuffia; diretta autonoma con la libreria del server; fino a 3 ospiti collegati con un link.

**Fase 6 – uscite e server senza AzuraCast** (in prova):

- Un solo server: ponte, Icecast principale e Caddy (HTTPS automatico). AzuraCast non serve più.
- Icecast secondario esterno con lo stesso segnale; musica di riserva dalla libreria quando nessuno è in diretta.
- Dirette video su YouTube e Facebook dal pannello: logo fisso o video da OBS (massimo 720p, senza ricodifica).

**Fase 7a – report SIAE** (in prova):

- Report SIAE trimestrale in CSV per il portale (colonne del fac simile senza il prezzo), una riga per opera con i passaggi.
- Il registro comprende anche i brani suonati dal server (diretta autonoma e musica di riserva), scaricati dal ponte.
- Autori, editore, ISWC e ISRC completati con MusicBrainz (solo i campi vuoti) ed elenco della musica con dati mancanti.

**Fase 7b – riconoscimento nelle esterne** (in prova):

- Impronte audio di tutta la libreria calcolate in regia e mandate al server; durante le dirette esterne il server riconosce i brani e li mette nel registro.
- Brani sconosciuti: 20 secondi di audio da etichettare dal pannello, poi riconosciuti da soli.
- I brani caricati dal pannello scendono in regia e vengono catalogati come Artista\Titolo.

**Fase 8 – programmi e puntate on demand** (in prova):

- Programmi creati dal pannello (fasce orarie, conduttori, copertina); il server registra da solo ogni fascia.
- Le registrazioni si rivedono dal pannello (inizio, fine, titolo, descrizione) e si pubblicano; solo streaming, niente download.
- Player pubblico su `/` (pannello su `/dashboard`) e pagina `podcast.html`; API dei podcast uguali a quelle di AzuraCast per l'app della radio.
- Repliche: pulsante nel pannello e azione degli eventi "Replica di un programma" (ultima puntata pubblicata).
- Titolo in onda agli indirizzi `/api/nowplaying` di AzuraCast; statistiche degli ascoltatori (Icecast principale e secondario, un anno) nel pannello e nella regia.

## Installazione su Windows

Scarica **RadioRegia-Setup-<versione>.exe** dall'ultima [release](https://github.com/crybakk/radiosoftware/releases); nella stessa pagina c'è lo ZIP del server (**RadioPonte-server-<versione>.zip**). Le novità di ogni versione sono in [CHANGELOG.md](CHANGELOG.md).

Per provare una modifica non ancora pubblicata: scheda **Actions**, l'ultima esecuzione di "Test e build Windows", artefatto **RadioRegia-Setup-Windows**.

Per pubblicare una nuova versione: aggiorna `version` in `package.json` e aggiungi la sezione `## v<versione>` in `CHANGELOG.md`, poi **Actions** → **Pubblica release** → **Run workflow** con lo stesso numero.

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
