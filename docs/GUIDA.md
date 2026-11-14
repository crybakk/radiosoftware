# Guida di Radio Regia

Guida d'uso aggiornata a ogni nuova funzione. In fondo trovi l'elenco delle modifiche.

**Ultimo aggiornamento:** 14/11/2026, fase 2 (ponte, collegamento, dirette esterne).

## Indice

1. [Come funziona, in breve](#1-come-funziona-in-breve)
2. [Installare la regia su Windows](#2-installare-la-regia-su-windows)
3. [Primo avvio: schede audio e libreria](#3-primo-avvio-schede-audio-e-libreria)
4. [In onda: uso quotidiano](#4-in-onda-uso-quotidiano)
5. [Libreria e scheda brano](#5-libreria-e-scheda-brano)
6. [Eventi a orario](#6-eventi-a-orario)
7. [Registro di trasmissione](#7-registro-di-trasmissione)
8. [Impostazioni](#8-impostazioni)
9. [Il server: VM su Proxmox con AzuraCast e il ponte](#9-il-server-vm-su-proxmox-con-azuracast-e-il-ponte)
10. [Collegare la regia al ponte](#10-collegare-la-regia-al-ponte)
11. [Dirette esterne](#11-dirette-esterne)
12. [Allarmi e notifiche](#12-allarmi-e-notifiche)
13. [Backup e ripristino](#13-backup-e-ripristino)
14. [Problemi comuni](#14-problemi-comuni)
15. [In arrivo](#15-in-arrivo)
16. [Modifiche alla guida](#16-modifiche-alla-guida)

---

## 1. Come funziona, in breve

```
PC di regia (Windows, 4G) ──▶ Ponte ──▶ AzuraCast ──▶ ascoltatori
                                 ▲
App per le esterne ──────────────┘
```

- La **regia** è il programma sul PC di regia: sceglie e manda in onda i brani, i jingle e gli eventi.
- Il **ponte** sta sul server di casa, insieme ad AzuraCast. Riceve l'audio dalla regia, lo tratta con il
  processore audio e lo passa ad AzuraCast. Se il 4G della regia cade, AzuraCast manda in onda la sua
  AutoDJ di riserva, e quando la regia si ricollega la diretta riprende da sola.
- Le **dirette esterne** si collegano al ponte. Finché sono collegate vanno in onda loro al posto della regia.

## 2. Installare la regia su Windows

1. Apri il repository su GitHub → scheda **Actions** → l'ultima esecuzione verde di "Test e build Windows".
2. In fondo alla pagina scarica **RadioRegia-Setup-Windows** ed estrai lo zip.
3. Avvia l'installer. Windows potrebbe avvisare che il programma non è firmato: scegli "Ulteriori informazioni" → "Esegui comunque".

Il programma si apre a schermo intero. Può esserne aperta una sola copia alla volta.

## 3. Primo avvio: schede audio e libreria

**Schede audio** (scheda **Impostazioni**):

- **Uscita in onda**: con il RodeCaster Duo collegato via USB, scegli il canale del RodeCaster dedicato al computer.
- **Uscita preascolto**: un'uscita diversa, per esempio le cuffie del PC o il canale chat del RodeCaster.
- Se un'uscita non compare, premi **Aggiorna elenco schede**.

**Libreria** (scheda **Libreria**):

1. Scegli il tipo (Musica, Jingle, Notiziario, Programma, Spot) e premi **+ Aggiungi cartella**.
2. Premi **Aggiorna libreria**: il programma legge i tag dei file (titolo, interprete, autori, editore, ISRC).
3. In sottofondo parte l'analisi dei brani: livella il volume di tutti i brani, trova dove inizia e
   finisce l'audio utile e dove far partire il brano successivo. Con 20.000 brani ci vuole un po', ma
   puoi andare in onda subito.

Quando aggiungi file nuove nelle cartelle, premi di nuovo **Aggiorna libreria**: legge solo le novità.

## 4. In onda: uso quotidiano

Scheda **In onda**:

- In alto a sinistra la spia **IN ONDA / FERMO**. In alto a destra il tasto **AUTOMATICO / MANUALE** e l'orologio.
- **AUTOMATICO**: la regia riempie la coda da sola rispettando le regole di rotazione e non lascia mai il silenzio.
- **MANUALE**: va in onda solo quello che metti in coda tu. Alla fine di un brano parte il successivo in coda.
- **▶ PLAY** fa partire la coda, **⏭ AVANTI** sfuma il brano in onda e passa al successivo, **■ STOP** sfuma e
  ferma tutto (e passa in manuale).
- Il riquadro grande mostra il brano in onda, il tempo trascorso e quello mancante: negli ultimi secondi diventa rosso.
- **Coda**: con le frecce sposti i brani, con la ✕ li togli. Accanto a ogni brano c'è l'orario previsto.
- **Ricerca** (a destra): cerca per titolo o artista. Con i tasti del brano lo metti come prossimo, lo aggiungi
  in fondo alla coda, oppure lo ascolti in cuffia (preascolto).
- **Jingle istantanei** (12 tasti): un clic lo fa partire sopra la musica. Con la matita assegni il jingle a un tasto.

## 5. Libreria e scheda brano

In **Libreria** trovi l'elenco dei brani. Con **Scheda** apri la scheda brano, dove puoi:

- correggere titolo, interprete, album, anno, genere e tipo;
- inserire **autori/compositori**, **editore** e **codice opera SIAE** (servono per il report SIAE);
- spostare inizio audio, fine audio e punto di mix se l'analisi automatica non ti convince;
- togliere il segno da **Attivo** per escludere un brano da rotazione e ricerca senza cancellarlo.

## 6. Eventi a orario

Scheda **Eventi** → **+ Nuovo evento**. Un evento esegue in ordine una serie di azioni a un orario.

**Quando:**

- **Una volta al giorno**, **Ogni ora** (al minuto scelto) oppure **Ogni N minuti** (da un orario a un altro).
- Giorni della settimana (con le scorciatoie Lun-Ven, Weekend, Tutti) e, se serve, date di inizio e fine validità.

**Come parte:**

- **Dopo il brano**: aspetta che finisca il brano in onda.
- **Dopo il brano, al massimo…**: aspetta, ma se il brano dura troppo lo sfuma dopo i secondi indicati.
- **Subito (sfuma il brano)**: parte all'orario esatto.

**Azioni disponibili:**

| Azione | Cosa fa |
|---|---|
| Brano | un brano preciso |
| Brano casuale | un brano a caso per tipo, genere o cartella (es. un jingle) |
| Playlist | una playlist M3U/PLS o una cartella: subito prima della coda, in fondo, oppure al posto della coda |
| Flusso esterno | un flusso internet (es. un notiziario) per N minuti |
| Automatico / manuale | cambia modalità |
| Svuota coda | toglie i brani in coda |
| Ferma tutto | ferma la messa in onda |
| Regole di rotazione | da quel momento la rotazione usa solo certi generi o anni (es. "dalle 22 musica tranquilla"); "Torna alla rotazione normale" la riporta come prima |
| Comando esterno | avvia un programma o uno script sul PC |

Con **▶ Prova** esegui subito un evento per vedere come va. **Duplica** crea una copia da modificare.
In alto vedi i prossimi eventi in programma e, se attivo, il profilo di rotazione in uso.

## 7. Registro di trasmissione

La scheda **Registro** elenca tutto quello che è andato in onda, con orario, durata, tipo, titolo, interprete,
autori e codice SIAE. Scegli le date e premi **Esporta CSV** (si apre con Excel).
Il registro indica quanti brani non hanno autori o codice SIAE: completali dalla scheda brano.

Il report SIAE nel formato del fac simile arriverà con la fase 7.

## 8. Impostazioni

| Impostazione | Cosa fa |
|---|---|
| Dissolvenza (secondi) | durata della sfumatura quando premi AVANTI |
| Volume obiettivo (LUFS) | volume a cui vengono livellati tutti i brani (-16 è lo standard per lo streaming) |
| Separazione artista / brano (minuti) | tempo minimo prima di ripetere lo stesso artista o lo stesso brano |
| Un jingle ogni … brani | in automatico; 0 = nessun jingle |
| Brani in coda in automatico | quanti brani preparare in anticipo |

Ricordati di premere **Salva**.

## 9. Il server: VM su Proxmox con AzuraCast e il ponte

Serve una volta sola. La guida tecnica completa è in [ponte/README.md](../ponte/README.md).

1. **Crea la VM**: copia `ponte/proxmox/crea-vm.sh` sul nodo Proxmox ed eseguilo come root.
   Con indirizzo fisso (consigliato):
   `IP=192.168.1.50/24 GATEWAY=192.168.1.1 bash crea-vm.sh`
   Crea una VM Ubuntu 24.04 con 4 core, 8 GB di RAM e 150 GB, che si avvia insieme a Proxmox.
2. **Installa**: entra nella VM (`ssh radio@192.168.1.50`), copia la cartella `ponte` ed esegui
   `sudo bash installa-server.sh`. Installa AzuraCast e il ponte e alla fine stampa i valori per la regia.
   Tienili da parte.
3. **AzuraCast**: apri `http://<indirizzo della VM>`, crea l'amministratore e la stazione. In
   **Profilo → Streamer/DJ** abilita i DJ e crea l'account per il ponte. Scrivi utente e password in
   `/opt/radio-ponte/.env` (`AZURACAST_DJ_UTENTE`, `AZURACAST_DJ_PASSWORD`), poi
   `cd /opt/radio-ponte && sudo docker compose up -d`.
4. **Router di casa**: inoltra verso la VM
   - TCP 80 e 443 (pagine di AzuraCast)
   - TCP 8000-8006 (ascolto della radio)
   - UDP 9000 (audio dalla regia)
   - TCP 9080 (allarmi, titoli, backup)
   - TCP 9010 (dirette esterne)
5. Se l'IP pubblico di casa cambia, usa un nome DNS dinamico (DuckDNS o quello del router) e mettilo nella
   regia al posto dell'IP. Con un nome di dominio AzuraCast può attivare l'HTTPS.

## 10. Collegare la regia al ponte

Scheda **Collegamento** → **Impostazioni del collegamento**:

- **Indirizzo del server**: IP pubblico o nome di dominio di casa.
- **Porta SRT**, **Frase segreta**, **Porta** e **Token del servizio di controllo**: i valori stampati dall'installazione.
- **Margine contro i buchi di rete**: 2000 ms vanno bene per il 4G. Se l'audio salta, alzalo.
- **Qualità**: 128 kbit/s.
- **Cosa inviare**:
  - *Solo il programma del computer*: musica, jingle ed eventi della regia.
  - *Un ingresso della scheda audio*: per esempio il mix del RodeCaster, così va in onda anche il microfono.
- **Backup automatico**: l'ora del backup giornaliero.
- **Invia artista e titolo ad AzuraCast**: lascialo attivo.

Premi **Salva**, poi **Accendi invio**. In alto compare la spia **PONTE**:

| Spia | Significato |
|---|---|
| verde "OK" | la regia è in onda attraverso il ponte |
| gialla "NON COLLEGATO" | collegamento in corso o caduto: la regia riprova da sola |
| rossa "ALLARMI" | il ponte segnala un problema (vedi scheda Collegamento) |

Quando il ponte è attivo, **RadioDJ non deve più collegarsi ad AzuraCast**.

## 11. Dirette esterne

Usa la stessa app di prima (BUTT, Larix, Luci Live…), in modalità Icecast. Cambia solo:

- **server**: l'indirizzo di casa;
- **porta**: 9010;
- **mount**, **utente** e **password**: quelli stampati dall'installazione (`ESTERNA_*` nel file `.env`).

Quando l'app si collega va in onda lei, con una breve dissolvenza. Quando si scollega torna da sola la regia.
Ricevi una notifica all'inizio e alla fine.

## 12. Allarmi e notifiche

Il ponte avvisa via Telegram e/o email (da configurare nel `.env` del server; la scheda **Collegamento** ha
**Invia notifica di prova**):

- regia scollegata dal ponte;
- programma della regia che non risponde (PC spento, app chiusa);
- silenzio in onda;
- collegamento instabile (troppe riconnessioni);
- errori verso AzuraCast;
- inizio e fine di una diretta esterna.

Quando il problema si risolve arriva un secondo messaggio. Gli allarmi attivi si vedono anche nella scheda Collegamento.

## 13. Backup e ripristino

Ogni giorno, all'ora scelta, la regia salva sul ponte una copia di libreria, eventi, registro e impostazioni.
Il ponte tiene gli ultimi 14.

- **Fai un backup adesso**: copia immediata, utile prima di grandi modifiche.
- **Mostra i backup sul ponte** → **Ripristina** → **Sì, ripristina**: la regia si riavvia con il backup scelto.
  La messa in onda si ferma per qualche secondo. Il database di prima resta in una copia a parte.

## 14. Problemi comuni

| Problema | Cosa controllare |
|---|---|
| "Il ponte non risponde" | porta UDP 9000 non inoltrata sul router, indirizzo sbagliato, VM spenta |
| "Frase segreta errata" | la frase segreta della regia è diversa da quella del `.env` |
| "token del ponte errato" | il token della regia è diverso da quello del `.env` |
| Allarme AzuraCast | account DJ sbagliato nel `.env`, o RadioDJ ancora collegato |
| La scheda audio scelta non è disponibile | il RodeCaster è scollegato o spento |
| L'app delle esterne non si collega | porta 9010 non inoltrata, oppure mount/utente/password diversi |

## 15. In arrivo

Prossime fasi (l'ordine può cambiare):

- pannello remoto dal browser: diretta con microfono, controllo del player, ospiti, diretta autonoma;
- uscite verso Icecast esterni, Fluidstream, YouTube e Facebook;
- analisi della libreria stile MusicBrainz e report SIAE nel formato del fac simile;
- registrazione della messa in onda e podcast, download automatico di notiziari, voce sintetica;
- più utenti con ruoli;
- rotazioni generate dall'AI a partire da una descrizione del palinsesto.

## 16. Modifiche alla guida

| Data | Novità |
|---|---|
| 14/11/2026 | Prima versione: regia (fase 1), eventi avanzati, ponte, collegamento, backup, dirette esterne, VM Proxmox |
