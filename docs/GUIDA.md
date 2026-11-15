# Guida di Radio Regia

Guida d'uso aggiornata a ogni nuova funzione. In fondo trovi l'elenco delle modifiche.

**Ultimo aggiornamento:** 15/11/2026, bot Telegram della radio (brani sconosciuti da etichettare e menu con stato, ascoltatori e puntate).

## Indice

1. [Come funziona, in breve](#1-come-funziona-in-breve)
2. [Installare la regia su Windows](#2-installare-la-regia-su-windows)
3. [Primo avvio: schede audio e libreria](#3-primo-avvio-schede-audio-e-libreria)
4. [In onda: uso quotidiano](#4-in-onda-uso-quotidiano)
5. [Libreria e scheda brano](#5-libreria-e-scheda-brano)
    - [Dati per il report SIAE (MusicBrainz)](#dati-per-il-report-siae-musicbrainz)
6. [Eventi a orario](#6-eventi-a-orario)
7. [Registro di trasmissione](#7-registro-di-trasmissione)
    - [Report SIAE trimestrale](#report-siae-trimestrale)
8. [Impostazioni](#8-impostazioni)
9. [Il server: VM su Proxmox](#9-il-server-vm-su-proxmox)
    - [Ascolto e Icecast secondario](#ascolto-e-icecast-secondario)
10. [Collegare la regia al ponte](#10-collegare-la-regia-al-ponte)
11. [Dirette esterne](#11-dirette-esterne)
    - [Riconoscimento dei brani nelle esterne](#riconoscimento-dei-brani-nelle-esterne)
12. [Pannello remoto e utenti](#12-pannello-remoto-e-utenti)
    - [Microfono dal pannello](#microfono-dal-pannello)
    - [Ospiti in diretta](#ospiti-in-diretta)
    - [Diretta autonoma dal server](#diretta-autonoma-dal-server)
    - [Libreria sul server](#libreria-sul-server)
    - [Dirette video su YouTube e Facebook](#dirette-video-su-youtube-e-facebook)
    - [Programmi e puntate on demand](#programmi-e-puntate-on-demand)
    - [Repliche](#repliche)
    - [Statistiche degli ascoltatori](#statistiche-degli-ascoltatori)
13. [Allarmi e notifiche](#13-allarmi-e-notifiche)
    - [Bot Telegram della radio](#bot-telegram-della-radio)
14. [Backup e ripristino](#14-backup-e-ripristino)
15. [Problemi comuni](#15-problemi-comuni)
16. [In arrivo](#16-in-arrivo)
17. [Modifiche alla guida](#17-modifiche-alla-guida)

---

## 1. Come funziona, in breve

```
PC di regia (Windows, 4G) ──▶ Ponte ──▶ Icecast principale (casa) ──▶ ascoltatori
                                 ▲   ├─▶ Icecast secondario (esterno, facoltativo)
App per le esterne ──────────────┘   └─▶ YouTube / Facebook (quando le avvii)
```

- La **regia** è il programma sul PC di regia: sceglie e manda in onda i brani, i jingle e gli eventi.
- Il **ponte** sta sul server di casa, insieme all'**Icecast principale** a cui si collegano gli ascoltatori.
  Riceve l'audio dalla regia, lo tratta con il processore audio e lo manda a tutte le uscite, sempre con lo
  stesso identico segnale.
- Le **dirette esterne** si collegano al ponte. Finché sono collegate vanno in onda loro al posto della regia.
- Se non c'è nessuna diretta (regia spenta o 4G caduto), il ponte suona da solo la **musica di riserva**:
  brani a caso della libreria del server, senza ripetere di seguito lo stesso artista. Quando la regia si
  ricollega la diretta riprende da sola.
- AzuraCast non serve più.

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

### Dati per il report SIAE (MusicBrainz)

Nel riquadro **Dati per il report SIAE** della Libreria, **Cerca su MusicBrainz** completa i dati che mancano
ai brani di musica:

- **autori** (compositori e parolieri dell'opera), separati da virgola;
- **editore**, **ISWC** (codice dell'opera) e **ISRC** (codice della registrazione).

Come funziona:

- riempie solo i campi vuoti: quello che hai scritto a mano non viene mai toccato;
- accetta un risultato solo se titolo e interprete corrispondono e la durata è simile (massimo 10 secondi di
  differenza), così una versione live o una cover non finiscono sul brano sbagliato;
- MusicBrainz concede una richiesta al secondo e ne servono circa due per brano: per 20.000 brani sono circa
  **12 ore**. Si può fermare e riprendere quando vuoi, riparte da dove era rimasta;
- usa internet, quindi conviene farla partire con la regia collegata a una rete senza limiti, o di notte.

Il **codice opera SIAE** non è su MusicBrainz: va scritto nella scheda brano.
**Riprova i brani non trovati** rimette in coda quelli già cercati che sono ancora incompleti, utile dopo qualche
mese perché MusicBrainz si arricchisce.
**Mostra la musica con dati mancanti** elenca i brani a cui mancano autori, editore o un codice (codice opera,
ISWC o ISRC): con **Scheda** li completi a mano.

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
| Replica di un programma | l'ultima puntata pubblicata del programma scelto, in streaming dal server (sezione 12, Repliche) |

Con **▶ Prova** esegui subito un evento per vedere come va. **Duplica** crea una copia da modificare.
In alto vedi i prossimi eventi in programma e, se attivo, il profilo di rotazione in uso.

## 7. Registro di trasmissione

La scheda **Registro** elenca tutto quello che è andato in onda, con orario, durata, tipo, titolo, interprete,
autori e codice SIAE. Scegli le date e premi **Esporta CSV** (si apre con Excel).
Il registro indica quanti brani non hanno autori o codice SIAE: completali dalla scheda brano.

La colonna **Fonte** dice da dove arriva ogni passaggio: **Regia**, **Diretta autonoma** o **Riserva del server**.
I brani suonati dal server quando la regia non è in onda vengono scaricati dal ponte ogni 10 minuti (e prima di
ogni report) e aggiunti al registro, una volta sola.

### Report SIAE trimestrale

In cima alla scheda **Registro** scegli anno e trimestre (di solito è già scelto quello appena finito):

- vedi una riga per opera e interprete con il numero di **passaggi** nel trimestre;
- contano solo i brani di **musica** (niente jingle, spot, notiziari) di tutte le fonti: regia, diretta autonoma
  e musica di riserva del server. I passaggi della regia sotto i 30 secondi (brano saltato) non contano;
- per i brani della libreria si usano i dati attuali della scheda brano, così le correzioni fatte dopo valgono
  anche per i passaggi già andati in onda;
- **Solo le opere con dati mancanti** mostra quelle senza autori, senza editore o senza nessun codice:
  completale con **Scheda**. "solo server" indica un brano caricato dal pannello che non è nella libreria della
  regia;
- **Salva CSV per il portale SIAE** crea il file da caricare: separato da punto e virgola, con le colonne del fac
  simile senza il prezzo di vendita: TITOLO OPERA, AUTORE, EDITORE, INTERPRETE, UTILIZZAZIONI, CODICE OPERA,
  CODICE ISWC, CODICE ISRC.

Se compare l'avviso "Brani suonati dal server non aggiornati", il ponte non era raggiungibile: il report contiene
solo i brani del server scaricati finora. Riprova quando il ponte è collegato.

## 8. Impostazioni

| Impostazione | Cosa fa |
|---|---|
| Dissolvenza (secondi) | durata della sfumatura quando premi AVANTI |
| Volume obiettivo (LUFS) | volume a cui vengono livellati tutti i brani (-16 è lo standard per lo streaming) |
| Separazione artista / brano (minuti) | tempo minimo prima di ripetere lo stesso artista o lo stesso brano |
| Un jingle ogni … brani | in automatico; 0 = nessun jingle |
| Brani in coda in automatico | quanti brani preparare in anticipo |

Ricordati di premere **Salva**.

## 9. Il server: VM su Proxmox

Serve una volta sola. La guida tecnica completa è in [ponte/README.md](../ponte/README.md).
Sul server girano il ponte, l'Icecast principale e Caddy, che si occupa da solo dell'HTTPS (certificato
Let's Encrypt gratuito, rinnovato in automatico).

1. **Nome di dominio**: serve un nome (per esempio `radio.esempio.it`) che punti all'IP pubblico di casa. Se l'IP
   cambia, usa un DNS dinamico (DuckDNS o quello del router).
2. **Chiave SSH del PC**: la VM accetta l'accesso SSH solo con una chiave, non con la password. Sul PC Windows
   apri PowerShell e scrivi `ssh-keygen -t ed25519` (premi Invio a tutte le domande), poi
   `type $env:USERPROFILE\.ssh\id_ed25519.pub` e copia la riga che stampa (inizia con `ssh-ed25519`).
   Nella Shell del nodo Proxmox scrivi `nano /root/chiave-pc.pub`, incolla la riga, salva (Ctrl+O, Invio, Ctrl+X).
3. **Crea la VM**: apri `ponte/proxmox/crea-vm.sh` su GitHub, premi **Copy raw file**, e nella Shell di Proxmox
   crea il file con `nano crea-vm.sh` (incolla, salva). Poi eseguilo come root:
   `CHIAVE_SSH=/root/chiave-pc.pub bash crea-vm.sh`
   Crea una VM Ubuntu 24.04 con 4 core, 4 GB di RAM e 300 GB di disco (servono per la musica), che si avvia
   insieme a Proxmox. Con meno spazio libero aggiungi per esempio `DISCO=200G`; con indirizzo fisso
   `IP=192.168.1.50/24 GATEWAY=192.168.1.1`. Senza `IP=` la VM prende l'indirizzo dal router (DHCP): in quel caso,
   sul router, fai assegnare alla VM sempre lo stesso indirizzo (sul Fritz!Box: Rete domestica → Rete → "radio" →
   "Assegna sempre lo stesso indirizzo IPv4"), altrimenti l'inoltro delle porte smette di funzionare.
   L'indirizzo della VM si vede sul router, oppure dalla console della VM su Proxmox (menu **Console → xterm.js**,
   premi Invio, entra come `radio`, scrivi `ip -br a`). La console di Proxmox non incolla bene: usala solo per
   questo e lavora via SSH dal PC.
4. **Copia il programma nella VM**: su GitHub, pulsante **Code → Download ZIP**. Poi in PowerShell sul PC:
   `scp $HOME\Downloads\radiosoftware-main.zip radio@<indirizzo>:` ed entra nella VM con `ssh radio@<indirizzo>`.
   Nella VM: `sudo apt-get install -y unzip && unzip -q radiosoftware-main.zip && cd radiosoftware-main/ponte`
5. **Installa**: `sudo DOMINIO=radio.esempio.it bash installa-server.sh` (con il tuo dominio). Alla fine stampa i
   valori per la regia, la password del pannello e le porte da aprire. Tienili da parte (restano anche in
   `/opt/radio-ponte/.env`).
6. **Router di casa**: inoltra verso la VM
   - TCP 80 e 443 (HTTPS: pannello, regia, ascolto)
   - TCP 8000 (ascolto senza https, facoltativo)
   - UDP 9000 (audio dalla regia)
   - TCP 9010 (dirette esterne)
   - UDP 40000-40049 (microfono dal pannello e ospiti)
   - UDP 9020 (video da OBS, solo se lo usi da fuori casa)

   Appena le porte 80 e 443 arrivano alla VM, il certificato si attiva da solo.
7. **Musica**: copia la selezione della libreria sul server (sezione 12, "Libreria sul server"). Serve alla
   diretta autonoma e alla musica di riserva.

Se nella VM avevi già installato AzuraCast con la versione precedente, toglilo
(`cd /var/azuracast && sudo ./docker.sh uninstall`) oppure crea una VM nuova: Caddy ha bisogno delle porte 80 e 443.

**Banda di casa:** ogni ascoltatore collegato all'Icecast principale usa 0,128 Mbit/s di upload. Con 20 Mbit/s in
upload ci stanno circa 150 ascoltatori (il massimo si imposta con `ICECAST_MAX_ASCOLTATORI`, di base 1000: con 500 Mbit/s in upload ce ne starebbero quasi 4000).

### Provare il server mentre AzuraCast è ancora acceso

Le porte 80, 443 e 8000 del router possono andare a una sola macchina. Per provare il nuovo server senza
spegnere AzuraCast:

- usa un altro nome che punti all'IP di casa (per esempio `player.radio.it`) e una porta esterna libera,
  per esempio **9443**: sul router inoltra TCP 9443 esterna → porta 443 della VM, più UDP 9000, TCP 9010 e
  UDP 40000-40049 (AzuraCast non le usa). La 443 e la 8000 restano ad AzuraCast;
- in `/opt/radio-ponte/.env` metti `DOMINIO=` quel nome e `ASCOLTO_URL=https://<nome>:9443/radio.mp3`,
  poi `sudo /opt/radio-ponte/riavvia.sh`;
- **certificato**: Let's Encrypt controlla solo la porta 80 (mai la 9443). Sposta sul router la TCP 80 verso
  la VM per qualche minuto, finché `docker compose logs caddy` (in `/opt/radio-ponte`) scrive
  "certificate obtained successfully", poi rimettila su AzuraCast. Il certificato dura 90 giorni: se le prove
  durano di più, ripeti lo spostamento;
- pannello: `https://<nome>:9443`; nella regia **Porta del servizio di controllo** 9443 con HTTPS spuntato.

Quando passi al server nuovo per davvero, togli AzuraCast, inoltra 80, 443 e 8000 alla VM, rimetti il dominio
definitivo in `DOMINIO`, svuota `ASCOLTO_URL` e riavvia.

### Ascolto e Icecast secondario

- Indirizzo per gli ascoltatori (sito, app, lettori): `https://<dominio>/radio.mp3` (MP3 a 128 kbit/s).
  Per i lettori che non usano https: `http://<dominio>:8000/radio.mp3`.
- Titolo in onda e numero di ascoltatori: `https://<dominio>/status-json.xsl`.
- **Icecast secondario**: se hai un Icecast su un altro server, scrivi i suoi dati in `/opt/radio-ponte/.env`
  (`ICECAST_ESTERNO_HOST`, `_PORTA`, `_MOUNT`, `_UTENTE`, `_PASSWORD`) e poi `sudo /opt/radio-ponte/riavvia.sh`.
  Riceve sempre lo stesso segnale del principale, anche la musica di riserva: se il server di casa non è
  raggiungibile, gli ascoltatori passano al secondario e sentono la stessa cosa. Nei lettori che lo permettono,
  mettilo come indirizzo di riserva.

## 10. Collegare la regia al ponte

Scheda **Collegamento** → **Impostazioni del collegamento**:

- **Indirizzo del server**: il nome di dominio della radio (senza `https://`).
- **Porta SRT**, **Frase segreta** e **Token del servizio di controllo**: i valori stampati dall'installazione.
- **Porta del servizio di controllo**: 443, con **"Il servizio di controllo usa HTTPS"** spuntato.
- **Margine contro i buchi di rete**: 2000 ms vanno bene per il 4G. Se l'audio salta, alzalo.
- **Qualità**: 128 kbit/s.
- **Cosa inviare**:
  - *Solo il programma del computer*: musica, jingle ed eventi della regia.
  - *Un ingresso della scheda audio*: per esempio il mix del RodeCaster, così va in onda anche il microfono.
- **Backup automatico**: l'ora del backup giornaliero.
- **Invia artista e titolo agli ascoltatori (Icecast)**: lascialo attivo.

Premi **Salva**, poi **Accendi invio**. In alto compare la spia **PONTE**:

| Spia | Significato |
|---|---|
| verde "OK" | la regia è in onda attraverso il ponte |
| gialla "NON COLLEGATO" | collegamento in corso o caduto: la regia riprova da sola |
| rossa "ALLARMI" | il ponte segnala un problema (vedi scheda Collegamento) |

Quando la regia si scollega, la spia diventa gialla e in onda va la musica di riserva del ponte.

## 11. Dirette esterne

Usa la stessa app di prima (BUTT, Larix, Luci Live…), in modalità Icecast. Cambia solo:

- **server**: il nome di dominio della radio;
- **porta**: 9010;
- **mount**, **utente** e **password**: quelli stampati dall'installazione (`ESTERNA_*` nel file `.env`).

Quando l'app si collega va in onda lei, con una breve dissolvenza. Quando si scollega torna da sola la regia
(o la musica di riserva, se la regia è spenta).
Ricevi una notifica all'inizio e alla fine.

### Riconoscimento dei brani nelle esterne

Durante una diretta esterna il server ascolta il programma e riconosce i brani, così finiscono nel registro
(fonte **Esterna**) e nel report SIAE senza scrivere nulla a mano. Solo nelle esterne: gli altri brani la regia li
conosce già.

- **Come riconosce:** confronta l'audio con le **impronte audio** della libreria della regia. Nessun servizio
  esterno: le impronte le calcola la regia (scheda **Libreria**, riga "Impronte audio", circa mezzo secondo a brano)
  e le manda al server di notte insieme alla libreria (circa 5 KB a brano, la prima volta circa 100 MB per
  20.000 brani, dentro il limite di MB del giorno). Funziona anche con la regia spenta.
- Un brano è riconosciuto dopo circa 20 secondi, anche se qualcuno ci parla sopra un po'. Riconosce anche i brani
  esclusi dalla selezione del server (live, sotto 192 kbps), perché le impronte sono di tutta la musica.
- **Brani sconosciuti:** se per almeno un minuto non riconosce nulla, il server salva **20 secondi di audio** e
  te lo segnala: con il [bot Telegram della radio](#bot-telegram-della-radio) arriva subito l'audio da
  etichettare nella chat; senza il bot arriva una notifica Telegram/email (al massimo una ogni mezz'ora). Nel **pannello**, sezione
  **Brani sconosciuti delle esterne**, lo ascolti e scrivi titolo, interprete, autori ed editore: da quel momento
  viene riconosciuto da solo e i passaggi già sentiti vanno nel registro. Se era parlato o rumore, premi
  **Non è musica**. Etichettare serve almeno il ruolo conduttore.
- Il brano sconosciuto entra nel registro solo dopo che lo hai etichettato.
- Per spegnere il riconoscimento: `RICONOSCIMENTO=no` nel file `.env` del server, poi `riavvia.sh`.

## 12. Pannello remoto e utenti

Il pannello remoto comanda la regia dal browser, da qualsiasi posto: telefono, tablet o computer.

**Aprirlo:** `https://<nome di dominio>` (vedi la sezione 9). La prima volta entra con `admin` e la password
stampata dall'installazione.

**Cosa trovi:**

- in alto la spia **IN ONDA / FERMO**, lo stato della regia (**REGIA OK** o **REGIA SCOLLEGATA**) e il tasto
  **AUTOMATICO / MANUALE**;
- il brano in onda con il tempo mancante (rosso negli ultimi 10 secondi);
- **PLAY**, **AVANTI** e **STOP**, che fanno esattamente quello che fanno in regia;
- la coda, con le frecce per spostare i brani e la ✕ per toglierli;
- la ricerca: ⤒ mette il brano come prossimo, + lo aggiunge in fondo;
- i jingle della cartwall e **Ferma jingle**.

Se compare un allarme del ponte, lo vedi in una striscia rossa in alto.

**Utenti** (menu ☰ → **Utenti**, solo per gli amministratori): scrivi nome, ruolo e password e premi **Salva**.
Per cambiare il ruolo di un utente esistente scrivi il suo nome, scegli il ruolo e lascia vuota la password.
Cambiando la password, l'utente viene scollegato da tutti i dispositivi.

| Ruolo | Cosa può fare |
|---|---|
| Amministratore | tutto, compresa la gestione degli utenti e delle chiavi di YouTube e Facebook |
| Conduttore | comandare la regia, microfono, ospiti, diretta autonoma, dirette video |
| Ospite | vedere cosa va in onda e cercare nella libreria, senza comandare |

**Nella regia** (scheda **Collegamento**) l'opzione "Permetti di comandare la regia dal pannello remoto" è
attiva di base. La riga "Pannello remoto" dice se il collegamento è attivo e mostra l'indirizzo del pannello.

Dopo 5 password sbagliate di fila dallo stesso indirizzo, il pannello blocca i tentativi per un minuto.

### Microfono dal pannello

Conduttori e amministratori possono parlare in diretta dal pannello, da casa o da fuori, senza passare dal
PC della regia. La voce va nel mixer del ponte insieme al programma della regia (o della diretta esterna).

1. Collega le **cuffie** e premi **🎙 Apri microfono**. Il browser chiede il permesso di usare il microfono:
   rispondi sì. Da questo momento in cuffia senti il programma, quasi senza ritardo, ma la tua voce
   **non è ancora in onda**. La barra mostra il livello del microfono: verde va bene, gialla è forte, rossa
   è troppo forte.
2. Premi **VAI IN ONDA**: la musica si abbassa (di 12 dB, regolabile) e la tua voce va in onda. Il tasto
   diventa rosso con la scritta **IN ONDA**. In cuffia continui a sentire il programma, senza la tua voce
   (così non senti l'eco).
3. Premi di nuovo il tasto rosso per uscire dall'onda: la musica torna su. **Chiudi microfono** spegne tutto.

Cose utili da sapere:

- funziona **solo con il pannello in HTTPS** (`https://<nome di dominio>`, vedi la sezione 9): i browser
  non danno il microfono alle pagine non protette;
- un solo microfono remoto alla volta: chi lo apre per secondo vede chi lo sta usando;
- se la connessione cade o chiudi la pagina, il microfono esce dall'onda da solo;
- la voce va in onda solo se c'è un programma: regia, diretta esterna o diretta autonoma (non sopra la musica di
  riserva). Con la regia spenta avvia la **diretta autonoma** (qui sotto) e parla sopra la musica del server;
- **Uso le cuffie**: lascialo spuntato. Senza cuffie toglilo prima di aprire il microfono: il browser
  attiva la riduzione dell'eco e del rumore, ma la voce suona meno naturale;
- **Ritorno**: volume del programma in cuffia.

### Ospiti in diretta

Puoi far parlare in diretta fino a **3 ospiti** collegati da casa, con il telefono o il computer, senza
installare nulla. Serve il pannello in HTTPS, come per il microfono.

1. Nel pannello, sezione **Ospiti**, scrivi per chi è il link (per esempio "Mario, intervista delle 18") e premi
   **Crea link**. Premi **Copia** (o **Invia…** dal telefono) e mandalo all'ospite, per esempio su WhatsApp.
   Il link vale 24 ore; da **Link attivi** puoi copiarlo di nuovo o **Revocarlo**.
2. L'ospite apre il link, scrive il nome, prova il microfono (la barra deve muoversi) e preme
   **Entra in sala d'attesa**. Intanto sente la radio.
3. Nel pannello compare l'ospite "in sala d'attesa": premi **Fai entrare** (o **Rifiuta**).
4. Quando l'audio è collegato, premi **Metti in onda**: la musica si abbassa e l'ospite va in onda. Sulla sua pagina
   compare **IN ONDA** in rosso. Premi di nuovo per toglierlo dall'onda, **Chiudi** per salutarlo.

In cuffia ognuno sente la radio e le altre voci in onda (tu, gli altri ospiti), ma non la propria. Consiglia
all'ospite di usare le **cuffie**: senza, deve togliere la spunta "Uso le cuffie" prima di entrare.
Se l'ospite chiude la pagina o perde la connessione esce dall'onda da solo; riaprendo lo stesso link torna in
sala d'attesa.

### Diretta autonoma dal server

Serve quando vuoi andare in onda senza la regia, per esempio da fuori con il telefono: il ponte suona la musica
che ha sul server, e tu puoi parlarci sopra con il microfono del pannello.

- **▶ Avvia diretta autonoma**: la musica del server va in onda **al posto della regia** (la regia può restare
  accesa, ma non si sente). Se si collega una diretta esterna, ha la precedenza.
- **Cerca nella libreria del server**: ⤒ mette il brano come prossimo, + lo aggiunge in fondo. Con la coda vuota il
  ponte sceglie da solo, senza ripetere troppo presto lo stesso brano o lo stesso artista.
- **⬆ Carica brani dal dispositivo**: scegli uno o più file dal telefono o dal computer; vengono caricati sul
  server e messi in coda.
- **⏭ Salta** passa al brano successivo; **■ Ferma e torna alla regia** chiude la diretta autonoma.

Il brano successivo si decide circa 20 secondi prima della fine di quello in onda: fino ad allora puoi cambiare la
coda. Tra un brano e l'altro non c'è dissolvenza. Inizio e fine della diretta autonoma arrivano come notifica.
Gli ospiti del pannello vedono cosa suona ma non la comandano.

### Libreria sul server

Nella regia, scheda **Collegamento**, sezione **Libreria sul server**. Sul server va solo una selezione:

- niente **live** (parola "live" o "dal vivo" nel genere, nella cartella, oppure nel titolo come "(Live)",
  "- Live at…"; titoli come "Live Forever" restano dentro);
- niente **interviste** ("intervista" nel titolo, nel genere o nella cartella);
- niente file sotto i **192 kbps** (modificabile).

Con **Scegli a mano** vedi gli esclusi con il motivo e puoi premere **Includi comunque**; con "Tutta la musica"
cerchi un brano e lo puoi **Escludere**. **Lascia decidere alla regola** annulla la scelta a mano.

**Prima copia (a mano, circa 100 GB):**

1. Collega un disco USB alla regia e premi **Copia la selezione su disco…**, scegliendo il disco. Copia solo i brani
   della selezione, già nelle cartelle giuste. Se la interrompi, alla ripartenza salta quelli già copiati.
2. Porta il disco a casa, collegalo al server (in Proxmox: passa il disco USB alla VM) ed esegui nella VM:
   `sudo rsync -a --info=progress2 /media/<disco>/regia/ /opt/radio-ponte/musica/regia/` e poi
   `sudo chown -R 1000:1000 /opt/radio-ponte/musica`.

La stessa libreria serve anche alla **musica di riserva**, che il ponte suona da solo quando non c'è nessuna
diretta. I brani sotto i 60 secondi (jingle, spot) non vengono scelti.

**Dopo:** la regia invia da sola via internet solo i brani **nuovi o cambiati**, e toglie dal server quelli usciti
dalla selezione. Lo fa **di notte** (di base dalle 1 alle 6) e al massimo **1 GB al giorno**, perché il 4G non è
illimitato: puoi cambiare ore e limite nella stessa sezione (poi **Salva**). **Invia ora i brani nuovi** parte
subito, ma rispetta il limite del giorno. Ogni giorno manda anche al server i titoli corretti e il volume misurato.
Se un giorno la regia vedesse sparire troppi brani (per esempio il disco della musica scollegato), si ferma e non
toglie nulla dal server.

Nelle stesse ore la regia:

- manda le **impronte audio** di tutta la musica, per il riconoscimento nelle esterne (sezione 11);
- **scarica i brani caricati dal pannello** e li cataloga nella prima cartella della musica come
  `Artista\Titolo.mp3` (se il nome è già usato da un altro file: `Titolo (2).mp3`). Poi da sola li legge, li
  analizza, calcola l'impronta e cerca autori e codici su MusicBrainz. Sul server il brano passa nella libreria
  della regia, così non viene rimandato indietro.

Tutto avviene solo con **Invia da solo** acceso (o con **Invia ora i brani nuovi**) e rientra nel limite di MB del
giorno.

### Dirette video su YouTube e Facebook

YouTube e Facebook vogliono un video: dal pannello, sezione **Dirette video**, mandi la radio con un'immagine.

**Una volta sola (amministratore):** apri **Impostazioni (chiavi delle dirette, ritardo)** e incolla la chiave
di YouTube (YouTube Studio → Trasmetti dal vivo → chiave dello stream) e/o di Facebook (Live Producer → chiave
di streaming), poi **Salva**. Le chiavi restano sul server: nel pannello non si vedono più. Per cambiarne una,
incolla quella nuova; un campo lasciato vuoto non cambia la chiave salvata.

**Immagine:**

- **Logo fisso**: carica un'immagine PNG o JPEG (ideale 1280×720) con **⬆ Carica il logo**. Il server la
  trasmette a 720p, quasi senza fatica.
- **Video da OBS**: la webcam (o altro) la gestisci in OBS, fuori dal programma. In OBS, Impostazioni →
  Stream: Servizio **Personalizzato**, Server `srt://<dominio>:9020` (in casa basta l'IP della VM), chiave
  vuota. Uscita: codificatore **x264**, risoluzione **1280×720** al massimo, fotogrammi chiave ogni **2 s**,
  2500-4000 kbit/s. Il pannello mostra l'indirizzo esatto quando scegli "Video da OBS". Il ponte inoltra il
  video così com'è, senza ricodificarlo; se OBS manda più di 720p si ferma e te lo dice.

**Andare in onda:** scegli l'immagine, spunta **YouTube** e/o **Facebook** e premi **▶ Avvia diretta video**.
Con OBS, dopo, premi "Avvia trasmissione" in OBS. Quando parte, il riquadro dice **IN ONDA**. **■ Ferma diretta
video** la chiude. L'audio è sempre quello della radio. Se il video di OBS e l'audio non sono allineati, regola
il **ritardo** nelle impostazioni (in millisecondi: positivo ritarda l'audio, negativo il video).

Se la diretta cade, il ponte riprova da solo e ti manda una notifica; se non riesce a ripartire si ferma.
Su YouTube e Facebook la diretta va comunque creata o programmata come sempre: il ponte manda solo il segnale.

### Programmi e puntate on demand

Dal pannello: menu **☰ → Programmi**.

**Programmi (solo amministratori).** **Nuovo programma**: nome, conduttori, descrizione e una o più **fasce
orarie** (giorni e orari; una fascia può passare la mezzanotte, es. 23:00 → 01:00). Con **Copertina** carichi
un'immagine quadrata PNG o JPG. Due interruttori:

- **Registra da solo le puntate nelle fasce**: il server registra quello che va in onda (regia, esterne, diretta
  autonoma, riserva) durante la fascia, con qualche minuto in più prima e dopo (di base 2, in **Impostazioni**);
- **Visibile nella pagina dei podcast e nell'app**: se spento, il programma e le sue puntate non si vedono.

**Revisione (conduttori e amministratori).** A fine fascia la registrazione compare in **Puntate da rivedere** (e
arriva una notifica). Ascoltala, porta il lettore dove inizia davvero la puntata e premi **Inizio qui**, poi dove
finisce e premi **Fine qui** (o scrivi gli orari come `0:02:30`). **Ascolta l'inizio** e **Ascolta la fine** fanno
sentire i punti di taglio. Scrivi titolo e descrizione e premi **Pubblica**: la puntata viene tagliata e diventa
ascoltabile. Se non serve, **Elimina**.

Sotto ogni programma ci sono le puntate pubblicate: **▶** per ascoltarle, **Modifica** (titolo e descrizione),
**Ritira** (sparisce dalla pagina e dall'app, ma il file resta; **Ripubblica** la rimette), **Elimina**. Le puntate
non scadono.

**Per gli ascoltatori:**

- `https://DOMINIO/podcast.html`: programmi e puntate da ascoltare;
- `https://DOMINIO/ascolta.html`: la diretta, con il titolo in onda.

Le puntate si possono **solo ascoltare in streaming**: nelle pagine non c'è il pulsante per scaricarle (la licenza
SIAE permette lo streaming, non il download). Non c'è un feed per Spotify o Apple Podcasts.

**App della radio.** Il server risponde agli stessi indirizzi delle API pubbliche dei podcast di AzuraCast
(`/api/station/<nome breve>/public/podcasts`, `.../podcast/<programma>/episodes`, ecc.), così l'app che oggi legge i
contenuti on demand da AzuraCast funziona cambiando solo l'indirizzo del server. Il **nome breve della stazione**
negli indirizzi si imposta in **Impostazioni** (in fondo alla pagina Programmi): metti lo stesso che usavi su
AzuraCast.

Anche il **titolo in onda** risponde come AzuraCast (`/api/nowplaying`): brano in onda con la durata, ultimi 5
brani, numero di ascoltatori dell'Icecast principale e diretta esterna segnata come "live". L'immagine è la
copertina del programma in onda oppure il logo caricato nelle dirette video. Il titolo arriva comunque anche
nel flusso Icecast, come prima.

**Spazio su disco:** a 128 kbps un'ora di registrazione occupa circa 58 MB (`PUNTATE_BITRATE` nel `.env`). Le bozze
non pubblicate restano finché non le elimini.

### Repliche

Una puntata pubblicata si può rimandare in onda dalla regia:

- **dal pannello**: nella pagina Programmi, pulsante **Replica** accanto alla puntata: va in coda nella regia dopo
  il brano in onda (serve la regia collegata);
- **con un evento**: azione **Replica di un programma**, scegli il programma; all'ora dell'evento va in onda la sua
  **ultima** puntata pubblicata.

L'audio arriva in streaming dal server, quindi la regia deve essere collegata a internet (circa 58 MB all'ora sul
4G). Nel registro la replica compare come flusso esterno: la musica dentro le repliche non entra nel report SIAE.

### Statistiche degli ascoltatori

Ogni minuto il server legge quanti ascoltatori ci sono sull'**Icecast principale** e su quello **secondario**, e
tiene lo storico per **un anno**. Si vedono in due posti, con gli stessi dati:

- **pannello**: il numero in alto (🎧) sono gli ascoltatori adesso; toccandolo (o menu **☰ → Ascoltatori**) si
  aprono le statistiche;
- **regia**: scheda **Ascoltatori** (serve il collegamento al ponte con il token).

Scegli **Giorno** o **Settimana** (da lunedì) e la data, con ◀ ▶ per spostarti. Trovi:

- **adesso**, **picco** (con l'ora), **media** e **ore di ascolto** (ascoltatori × ore: 10 persone per un'ora = 10);
- il grafico dell'andamento (media ogni 10 minuti nel giorno, ogni ora nella settimana): passandoci sopra vedi
  media, picco e la divisione tra principale e secondario;
- la **media per ora del giorno**, per capire le fasce più ascoltate;
- la tabella **per programma** (dalle fasce dei programmi): media, picco e ore di ascolto.

**Icecast secondario:** il server prova prima la pagina pubblica `status-json.xsl` di quel server. Se è chiusa,
metti nel `.env` del server `ICECAST_ESTERNO_ADMIN_UTENTE` e `ICECAST_ESTERNO_ADMIN_PASSWORD` (le credenziali di
amministrazione di quell'Icecast) e riavvia. Se non si riesce a leggere, le statistiche contano solo il principale
e la pagina lo dice.

## 13. Allarmi e notifiche

Il ponte avvisa via Telegram e/o email (da configurare nel `.env` del server; la scheda **Collegamento** ha
**Invia notifica di prova**):

- regia scollegata dal ponte;
- programma della regia che non risponde (PC spento, app chiusa);
- silenzio in onda;
- collegamento instabile (troppe riconnessioni);
- errori verso l'Icecast principale o il secondario;
- diretta video interrotta o che non riesce a ripartire;
- inizio e fine di una diretta esterna;
- avvio e fine della diretta autonoma, con il nome di chi l'ha comandata.

Quando il problema si risolve arriva un secondo messaggio. Gli allarmi attivi si vedono anche nella scheda Collegamento.

### Bot Telegram della radio

Un secondo bot, diverso da quello degli allarmi, per etichettare i brani sconosciuti delle esterne dal telefono
e vedere a colpo d'occhio come va la radio. È **solo lettura**: non comanda la regia, le dirette o le puntate.
Chiunque sia nella chat può usarlo, anche per etichettare.

**Come attivarlo (una volta):**

1. Su Telegram scrivi a **@BotFather** → `/newbot`, scegli nome e username: ti dà il **token**.
2. Crea un gruppo (o usa quello degli allarmi), aggiungi il bot e scrivi un messaggio qualsiasi nel gruppo.
3. Apri `https://api.telegram.org/bot<TOKEN>/getUpdates` nel browser: l'id della chat è il numero dopo
   `"chat":{"id":` (per i gruppi comincia con `-`).
4. Nel `.env` del server metti `TELEGRAM_ETICHETTE_TOKEN` e `TELEGRAM_ETICHETTE_CHAT_ID`, poi `riavvia.sh`.

Il bot legge solo i comandi e le risposte ai suoi messaggi, non il resto della chat.

**Brani sconosciuti:** per ogni brano sconosciuto il bot manda i 20 secondi di audio. **Rispondi al messaggio**
(tieni premuto → Rispondi) con `Artista - Titolo`; se li sai, sulla riga sotto gli autori separati da virgola.
Il bot conferma con ✅ e da quel momento il brano viene riconosciuto. Se era parlato premi **🚫 Non è musica**.
Editore e altri dati si possono aggiungere dopo dal pannello.

**Menu:** scrivi `/menu` (o `/start`) e scegli una sezione. Se nel gruppo c'è anche il bot degli allarmi, scrivi
`/menu@nomedelbot` (Telegram lo propone da solo quando scrivi `/`). Sotto ogni sezione ci sono **🔄 Aggiorna** e **⬅ Menu**.

| Sezione | Cosa mostra |
|---|---|
| 🎵 Da etichettare | ti rimanda l'audio dei brani ancora da etichettare (al massimo 20 per volta; anche con `/sconosciuti`) |
| ✅ Già etichettati | gli ultimi 15 brani etichettati, con gli autori |
| 📻 In onda | chi trasmette (regia, diretta autonoma, esterna o musica di riserva), voci dal pannello, brano in onda, regia collegata, allarmi attivi |
| 🎧 Ascoltatori | adesso (principale e secondario), picco, media e ore di ascolto di oggi e della settimana |
| 🎙 Puntate | programmi in registrazione e puntate in bozza da pubblicare dal pannello |

## 14. Backup e ripristino

Ogni giorno, all'ora scelta, la regia salva sul ponte una copia di libreria, eventi, registro e impostazioni.
Il ponte tiene gli ultimi 14.

- **Fai un backup adesso**: copia immediata, utile prima di grandi modifiche.
- **Mostra i backup sul ponte** → **Ripristina** → **Sì, ripristina**: la regia si riavvia con il backup scelto.
  La messa in onda si ferma per qualche secondo. Il database di prima resta in una copia a parte.

## 15. Problemi comuni

| Problema | Cosa controllare |
|---|---|
| "Il ponte non risponde" | porta UDP 9000 non inoltrata sul router, indirizzo sbagliato, VM spenta |
| "Frase segreta errata" | la frase segreta della regia è diversa da quella del `.env` |
| "token del ponte errato" | il token della regia è diverso da quello del `.env` |
| Allarme Icecast secondario | host, porta, mount o password `ICECAST_ESTERNO_*` sbagliati, oppure server esterno spento |
| Il pannello non si apre in https | il dominio non punta all'IP di casa, o le porte 80/443 non arrivano alla VM (`docker compose logs caddy`) |
| La scheda audio scelta non è disponibile | il RodeCaster è scollegato o spento |
| L'app delle esterne non si collega | porta 9010 non inoltrata, oppure mount/utente/password diversi |
| Il pannello dice REGIA SCOLLEGATA | regia spenta o senza internet, oppure "Permetti di comandare la regia dal pannello remoto" disattivato |
| Il pannello non si apre | porte 80 e 443 non inoltrate verso la VM |
| "No supported authentication methods" o password rifiutata via SSH | la VM accetta solo la chiave SSH: ricrea la VM con `CHIAVE_SSH=`, oppure dalla console della VM `sudo sed -i 's/no/yes/' /etc/ssh/sshd_config.d/60-cloudimg-settings.conf` e `sudo systemctl restart ssh` |
| `installa-server.sh` si ferma subito con errori strani (`$'\r'`) | i file sono passati da Windows con le righe in formato Windows: riscarica lo ZIP da GitHub, oppure nella cartella `ponte` esegui `find . -type f -exec sed -i 's/\r$//' {} +` |
| "Il microfono funziona solo con il pannello aperto in HTTPS" | apri il pannello con `https://` e il nome di dominio (sezione 9) |
| Il microfono si apre ma non si sente nulla, oppure si chiude dopo 20 secondi | porte UDP 40000-40049 non inoltrate sul router verso la VM |
| "la libreria del server è vuota" | fai la prima copia della selezione (sezione 12, Libreria sul server) o carica brani dal pannello |
| "la selezione toglierebbe … brani dal server" | il disco o la cartella della musica della regia non è collegato: ricollegalo e riprova |
| La regia non invia brani al server | fuori dalle ore di invio, limite del giorno raggiunto, oppure "Invia da solo" spento |
| L'ospite dice "Link non valido o scaduto" | il link ha più di 24 ore o è stato revocato: creane uno nuovo |
| L'ospite entra ma non si sente / "si sta collegando…" resta fermo | porte UDP 40000-40049 non inoltrate, oppure la rete dell'ospite blocca l'audio: prova con un'altra rete (per esempio dati del telefono) |
| "Permesso del microfono negato dal browser" | nelle impostazioni del sito nel browser consenti il microfono, poi ricarica la pagina |
| Diretta video "in attesa del video da OBS" | OBS non è in trasmissione, oppure non raggiunge la porta UDP 9020 (indirizzo o frase segreta) |
| "OBS manda 1920x1080" | in OBS, Impostazioni → Video: risoluzione di uscita 1280×720 |
| "manca la chiave di YouTube/Facebook" | un amministratore deve inserirla nelle impostazioni delle dirette video |
| "Ricerca fermata: MusicBrainz non raggiungibile" | la regia non ha internet o MusicBrainz è in manutenzione: riprova più tardi, riparte da dove era rimasta |
| Nelle esterne non riconosce nessun brano | la regia non ha ancora mandato le impronte: controlla "Impronte audio" in Libreria e "impronte sul server" nella sezione Libreria sul server |
| Il bot Telegram della radio non risponde alle etichette | bisogna **rispondere** al messaggio con l'audio (non scrivere un messaggio nuovo); id della chat sbagliato in `TELEGRAM_ETICHETTE_CHAT_ID`; con due bot nel gruppo usa `/menu@nomedelbot` |
| Nel log "lettura messaggi: Conflict" | lo stesso token è usato da un altro programma o è il bot degli allarmi: usa un bot diverso |
| Troppi brani sconosciuti che erano parlato | premi **Non è musica**: vengono tolti dall'archivio |
| Le statistiche non contano il secondario | pagina `status-json.xsl` del secondario chiusa: imposta `ICECAST_ESTERNO_ADMIN_UTENTE` e `ICECAST_ESTERNO_ADMIN_PASSWORD` |
| Un programma non si registra | controlla che "Registra da solo" sia acceso e le fasce (giorni e orari); l'ora è quella italiana del server |
| L'app non trova le puntate | il nome breve della stazione in Programmi → Impostazioni è diverso da quello che usa l'app; oppure il programma è nascosto |
| "replica … non disponibile" nella regia | il programma non ha puntate pubblicate, è nascosto, oppure la regia non raggiunge il ponte |
| Nel report mancano i brani della notte | il ponte non era raggiungibile quando hai aperto il report: premi **Aggiorna** con il ponte collegato |

## 16. In arrivo

Prossime fasi (l'ordine può cambiare):

- FluidStream, se un giorno servirà;
- download automatico di notiziari, voce sintetica;
- rotazioni generate dall'AI a partire da una descrizione del palinsesto.

## 17. Modifiche alla guida

| Data | Novità |
|---|---|
| 14/11/2026 | Prima versione: regia (fase 1), eventi avanzati, ponte, collegamento, backup, dirette esterne, VM Proxmox |
| 15/11/2026 | Pannello remoto dal browser, utenti con ruoli, HTTPS con il certificato di AzuraCast, `riavvia.sh` |
| 15/11/2026 | Microfono dal pannello remoto: voce in onda con la musica che si abbassa, ritorno in cuffia; nuova porta UDP 40000-40049 |
| 15/11/2026 | Diretta autonoma dal server (dal pannello), libreria sul server con selezione automatica, copia su disco USB e invio notturno; disco della VM a 300 GB |
| 15/11/2026 | Ospiti in diretta con un link: sala d'attesa, fai entrare, in onda, fino a 3 insieme, ritorno in cuffia per tutti |
| 15/11/2026 | Server senza AzuraCast: Icecast principale e HTTPS automatico (Caddy) nella stessa VM; regia sulla porta 443; Icecast secondario con lo stesso segnale; musica di riserva quando nessuno è in diretta; dirette video su YouTube e Facebook (logo o OBS, massimo 720p) |
| 15/11/2026 | Report SIAE trimestrale in CSV per il portale; brani della diretta autonoma e della riserva nel registro; autori, editore, ISWC e ISRC da MusicBrainz; elenco della musica con dati mancanti |
| 15/11/2026 | Riconoscimento dei brani nelle dirette esterne con le impronte della libreria; brani sconosciuti da ascoltare ed etichettare nel pannello; i brani caricati dal pannello scendono in regia e vengono catalogati come Artista\Titolo |
| 15/11/2026 | Programmi dal pannello con fasce e copertina; registrazione automatica delle puntate, revisione e pubblicazione; pagine `podcast.html` e `ascolta.html`; API dei podcast come AzuraCast per l'app; repliche dal pannello e con gli eventi |
| 15/11/2026 | Titolo in onda, ultimi brani e ascoltatori agli indirizzi `/api/nowplaying` di AzuraCast, per l'app |
| 15/11/2026 | Statistiche degli ascoltatori nel pannello e nella regia (scheda Ascoltatori): adesso, picco, media, ore di ascolto, grafici del giorno e della settimana, per ora e per programma; storico di un anno |
| 15/11/2026 | Installazione su Proxmox passo passo: chiave SSH dal PC, copia del programma con lo ZIP, VM in DHCP; prove del server nuovo con AzuraCast ancora acceso (altro nome e porta 9443) |
| 15/11/2026 | Bot Telegram della radio: audio dei brani sconosciuti da etichettare rispondendo nella chat, "Non è musica", menu in sola lettura con stato, ascoltatori, puntate e brani etichettati |
