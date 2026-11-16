# Server della radio: ponte di Radio Regia, Icecast e HTTPS

Tutto gira in una sola VM (o su un server Linux qualsiasi con Docker):

- **ponte** (Liquidsoap): riceve il programma dalla regia (anche dietro NAT 4G), le dirette esterne,
  il microfono dal pannello e gli ospiti; passa tutto nel processore audio e lo manda alle uscite;
- **Icecast principale**: qui si collegano gli ascoltatori;
- **Icecast secondario** (facoltativo, su un altro server): riceve lo stesso identico segnale, così se il
  server di casa non è raggiungibile gli ascoltatori passano a quello;
- **controllo** (Node): allarmi, titoli, backup, pannello remoto, ospiti, diretta autonoma, dirette video;
- **Caddy**: HTTPS automatico con Let's Encrypt per pannello, regia e ascolto.

```
Regia (Windows, 4G) ──SRT/UDP──▶ Ponte (Liquidsoap) ──▶ Icecast principale ──▶ ascoltatori
App per le esterne ──Icecast──▶       │            ──▶ Icecast secondario (esterno)
Pannello: microfono, ospiti ─WebRTC─▶ │            ──▶ YouTube / Facebook (dal pannello, quando servono)
OBS (facoltativo) ──SRT/UDP──▶ controllo (video per YouTube e Facebook)
Regia ──HTTPS + token──▶ Caddy ──▶ controllo (allarmi, titoli, backup, comandi dal pannello)
```

**Cosa va in onda**, in ordine di precedenza: diretta esterna, diretta autonoma dal pannello, regia.
Se non c'è nessuno, il ponte suona da solo la **musica di riserva**: brani a caso della libreria del server,
senza ripetere di seguito lo stesso artista. Tutte le uscite hanno sempre lo stesso segnale.

## Installazione rapida su Proxmox (VM nuova)

1. Copia `proxmox/crea-vm.sh` sul nodo Proxmox ed eseguilo come root: `CHIAVE_SSH=/root/chiave-pc.pub bash crea-vm.sh`
   (`chiave-pc.pub` = la chiave pubblica SSH del PC: la VM non accetta la password via SSH).
   Crea una VM Ubuntu 24.04 con 4 core, 4 GB di RAM e 300 GB di disco (la selezione della libreria occupa
   circa 100 GB), che parte da sola insieme a Proxmox.
   Per indirizzo fisso, storage o dimensioni diverse: `IP=192.168.1.50/24 GATEWAY=192.168.1.1 STORAGE=local-lvm DISCO=200G bash crea-vm.sh`.
2. Entra nella VM (`ssh radio@<indirizzo>`), copia la cartella `ponte` (per esempio lo ZIP del repository con `scp`) ed esegui
   `sudo DOMINIO=radio.esempio.it bash installa-server.sh` (con il tuo dominio).
   Installa Docker, genera frase segreta, token e password, avvia tutto e alla fine stampa i valori da
   inserire nella regia e le porte da aprire sul router.
3. Sul router inoltra le porte (vedi sotto) e controlla che il dominio punti all'IP pubblico di casa:
   Caddy ottiene il certificato da solo.

Le sezioni seguenti spiegano gli stessi passaggi a mano, per esempio su un server già esistente.

> **Prima c'era AzuraCast.** Questa versione non lo usa più: Caddy ha bisogno delle porte 80 e 443.
> Se nella VM c'è ancora AzuraCast, toglilo (`cd /var/azuracast && sudo ./docker.sh uninstall`) oppure crea una
> VM nuova. Gli ascoltatori useranno il nuovo indirizzo `https://<dominio>/radio.mp3`.

## Cosa serve

- Un nome di dominio che punti all'IP pubblico di casa (per esempio `radio.esempio.it`; con IP dinamico
  serve un servizio DNS dinamico).
- Porte da inoltrare sul router verso la VM (e da aprire nel firewall, se ce n'è uno):

| Porta | A cosa serve |
|---|---|
| **TCP 80 e 443** | HTTPS: pannello remoto, collegamento della regia, ascolto `https://` |
| TCP 8000 (`ICECAST_PORTA`) | ascolto senza https, per i lettori vecchi (facoltativo) |
| **UDP 9000** (`SRT_PORT`) | audio dalla regia |
| TCP 9010 (`ESTERNA_PORTA`) | dirette esterne |
| **UDP 40000-40049** (`WEBRTC_PORTE`) | microfono dal pannello e ospiti |
| UDP 9020 (`VIDEO_OBS_PORTA`) | video da OBS per YouTube e Facebook (solo se lo usi da fuori casa) |

**Banda**: ogni ascoltatore dell'Icecast principale usa 0,128 Mbit/s di upload della connessione di casa
(MP3 a 128 kbit/s). Con 20 Mbit/s in upload ci stanno circa 150 ascoltatori; il limite si imposta con
`ICECAST_MAX_ASCOLTATORI`. Con molti ascoltatori conviene mandarne una parte all'Icecast secondario.

## 1. Copia i file e compila le impostazioni

Sul server, in una cartella a scelta (per esempio `/opt/radio-ponte`), copia la cartella `ponte` di questo repository, poi:

```bash
cd /opt/radio-ponte
cp .env.esempio .env
nano .env
```

Valori da compilare (le spiegazioni sono nel file):

| Variabile | Cosa mettere |
|---|---|
| `NOME_RADIO` | Nome della radio (compare nelle notifiche e su Icecast) |
| `DOMINIO` | Il nome di dominio della radio, per l'HTTPS |
| `SRT_PASSPHRASE` | Frase segreta da 10 a 79 caratteri, da inserire uguale nella regia |
| `CONTROLLO_TOKEN` | Token lungo e casuale, da inserire uguale nella regia. Si può generare con `openssl rand -hex 24` |
| `PANNELLO_ADMIN_PASSWORD` | Password dell'utente `admin` del pannello remoto (almeno 8 caratteri) |
| `ICECAST_PASSWORD_SORGENTE`, `ICECAST_PASSWORD_ADMIN` | Password dell'Icecast principale (`openssl rand -hex 12`) |
| `ICECAST_PASSWORD_RELAY` | Password del relay di Icecast, diversa dall'amministrazione (se manca la crea `riavvia.sh`) |
| `SPAZIO_MINIMO_MB` | MB liberi da lasciare sul disco (2048 di base): sotto, niente registrazioni né file ricevuti, e allarme |
| `ICECAST_ESTERNO_*` | Facoltativi: dati dell'Icecast secondario (host, porta, mount, utente, password) |
| `ESTERNA_PASSWORD` | Password per l'app delle dirette esterne (vuota = ingresso spento) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SMTP_*`, `EMAIL_*` | Facoltativi: dove ricevere gli allarmi |
| `TELEGRAM_ETICHETTE_TOKEN`, `TELEGRAM_ETICHETTE_CHAT_ID` | Facoltativi: bot della radio (brani sconosciuti da etichettare e menu in sola lettura) |

## 2. Avvio

```bash
sudo ./riavvia.sh           # avvia (e in seguito riavvia/aggiorna) tutto
docker compose logs -f      # per controllare (Ctrl+C per uscire)
docker compose logs caddy   # se il certificato non arriva: porte 80/443 o dominio
```

I servizi ripartono da soli dopo un riavvio del server.

## 3. Nella regia

Scheda **Collegamento**:

- **Indirizzo del server**: il dominio (es. `radio.esempio.it`), senza `https://`.
- **Porta SRT**, **Frase segreta**, **Token del servizio di controllo**: gli stessi valori del file `.env`.
- **Porta del servizio di controllo**: `443`, con **HTTPS** spuntato.
- **Cosa inviare**: "Solo il programma del computer" manda musica, jingle ed eventi della regia.
  Se i microfoni passano dal RodeCaster, scegli "Un ingresso della scheda audio" e l'ingresso del RodeCaster
  con il mix principale, così in diretta va anche la voce.
- **Salva**, poi **Accendi invio**. La spia in alto a destra diventa verde ("PONTE: OK").

Con **Invia notifica di prova** controlli che Telegram o l'email arrivino.

## Ascolto

- `https://<dominio>/radio.mp3`: lo stream per siti, app e lettori (MP3, `ICECAST_BITRATE` kbit/s).
- `http://<dominio>:8000/radio.mp3`: lo stesso senza https.
- `https://<dominio>/status-json.xsl`: titolo in onda e numero di ascoltatori (JSON di Icecast).
- `https://<dominio>/admin/`: amministrazione di Icecast (utente `admin`, `ICECAST_PASSWORD_ADMIN`), solo in
  HTTPS. Sulla porta 8000 (in chiaro) l'ascolto funziona come prima, ma `/admin` è bloccato: la porta la
  pubblica Caddy, che passa a Icecast tutto il resto, così la password non viaggia mai leggibile in rete.

Titolo e artista arrivano dalla regia (o dal file, per la diretta autonoma e la musica di riserva).

Pagine per gli ascoltatori (servite dal controllo, dietro Caddy):

- `https://<dominio>/ascolta.html`: la diretta con il titolo in onda;
- `https://<dominio>/podcast.html`: programmi e puntate on demand (solo ascolto in streaming).

## Programmi e puntate on demand

I programmi si creano dal pannello (menu **Programmi**, amministratori). Durante le fasce dei programmi con la
registrazione attiva, il controllo registra il programma in onda dal flusso interno di Liquidsoap
(`PUNTATE_BITRATE`, di base 128 kbit/s, circa 58 MB all'ora) nella cartella dati `programmi/registrazioni/`.
A fine fascia la registrazione diventa una bozza: dal pannello si scelgono inizio e fine, titolo e descrizione,
e si pubblica (taglio senza ricodifica in `programmi/puntate/`). `REGISTRAZIONE_PUNTATE=no` spegne le registrazioni.

API pubbliche, con gli stessi indirizzi e lo stesso formato delle API pubbliche dei podcast di AzuraCast
(per l'app della radio), senza accesso e con CORS aperto:

- `GET /api/station/<nome breve>/public/podcasts`
- `GET /api/station/<nome breve>/public/podcast/<programma>` e `.../art`
- `GET /api/station/<nome breve>/public/podcast/<programma>/episodes`
- `GET /api/station/<nome breve>/public/podcast/<programma>/episode/<puntata>` e `.../download.mp3` (audio in
  streaming, con Range)

Titolo in onda, sempre come AzuraCast: `GET /api/nowplaying`, `/api/nowplaying/<nome breve>` e
`/api/nowplaying_static/<nome breve>.json` (brano in onda con durata, ultimi 5 brani, ascoltatori letti
dall'Icecast principale, diretta esterna come "live"), più `/api/station/<nome breve>/playlist.m3u|pls`.
L'immagine dei brani è la copertina del programma in onda, altrimenti il logo caricato per le dirette video
(`/api/logo`).

Statistiche degli ascoltatori: ogni minuto il controllo legge l'Icecast principale (`ICECAST_INTERNO`, di base
`http://icecast:8000`) e il secondario (pagina pubblica `status-json.xsl`, oppure `/admin/stats` con
`ICECAST_ESTERNO_ADMIN_UTENTE`/`ICECAST_ESTERNO_ADMIN_PASSWORD`); i dati restano un anno nella cartella dati
`ascoltatori/`. Si vedono dal pannello (Ascoltatori) e dalla regia; `GET /api/ascoltatori?periodo=giorno|settimana&data=AAAA-MM-GG`.

Il nome breve si imposta dal pannello (Programmi → Impostazioni); al posto del nome breve va bene anche `1`.
Non c'è il feed RSS (niente Spotify o Apple Podcasts).

## Icecast secondario

Se hai un Icecast su un altro server (un servizio di streaming o un VPS), scrivi i suoi dati in
`ICECAST_ESTERNO_HOST`, `ICECAST_ESTERNO_PORTA`, `ICECAST_ESTERNO_MOUNT`, `ICECAST_ESTERNO_UTENTE` e
`ICECAST_ESTERNO_PASSWORD`, poi `sudo ./riavvia.sh`. Riceve sempre lo stesso segnale del principale, anche la
musica di riserva. Nei tuoi lettori puoi mettere il secondario come indirizzo di riserva.

## Pannello remoto

Dal browser (telefono, tablet o computer) apri `https://<dominio>` ed entra con l'utente `admin`
e la password `PANNELLO_ADMIN_PASSWORD` del file `.env`.

Dal pannello vedi cosa va in onda e la coda, e puoi premere PLAY / AVANTI / STOP, passare tra automatico e
manuale, cercare un brano e metterlo in coda, far partire i jingle. Funziona anche con la regia dietro il 4G:
è la regia ad aprire il collegamento verso il ponte.

Ruoli (menu ☰ → Utenti, solo per gli amministratori):

| Ruolo | Cosa può fare |
|---|---|
| Amministratore | tutto, compresa la gestione degli utenti e delle chiavi delle dirette video |
| Conduttore | comandare la regia, usare il microfono, gestire ospiti, diretta autonoma e dirette video |
| Ospite | vedere soltanto, senza microfono (per gli ospiti in diretta si usa il link, vedi sotto) |

### Microfono dal pannello

Conduttori e amministratori possono aprire il microfono dal pannello (WebRTC, Opus). La voce arriva al
servizio di controllo, che la passa a Liquidsoap sulla rete interna (RTP, UDP 41030); quando il conduttore
preme VAI IN ONDA la musica si abbassa di `ABBASSAMENTO_MUSICA_DB` e la voce entra nel mixer prima del
processore audio. Liquidsoap rimanda al conduttore il programma senza la sua voce (UDP 41040, interno).

- Serve il pannello in **HTTPS** (i browser danno il microfono solo alle pagine protette): con Caddy è automatico.
- Inoltra sul router le porte **UDP `WEBRTC_PORTE`** (predefinite 40000-40049) verso il server.
- Il ponte annuncia al browser l'indirizzo del nome con cui è stato aperto il pannello, più quelli in
  `WEBRTC_INDIRIZZI` (l'installazione ci mette l'IP del server nella rete di casa).
- Un microfono alla volta; se il conduttore si scollega la voce esce dall'onda da sola.
- La voce va in onda solo quando c'è un programma (regia, esterna o diretta autonoma), non sopra la musica di riserva.
- `MICROFONO_REMOTO=no` lo disattiva.

### Ospiti

Dal pannello (sezione Ospiti) un conduttore crea un **link** valido 24 ore (revocabile) e lo manda all'ospite.
L'ospite apre `https://<dominio>/ospite.html?t=...`, scrive il nome, prova il microfono ed entra in
**sala d'attesa**, dove sente la radio (`ASCOLTO_URL`, di base l'Icecast principale). Il conduttore lo fa entrare,
lo mette in onda, lo toglie, lo chiude. Al massimo **3 ospiti** insieme, più il microfono del conduttore.

Ognuno sente in cuffia il programma e le altre voci in onda, ma non la propria (mix-minus fatto in Liquidsoap).
Porte interne (rete Docker): voci 41030/41032/41034/41036, ritorni 41040/41042/41044/41046 (pari, perché RTP usa
la successiva per RTCP). All'esterno servono solo la 443 e le UDP `WEBRTC_PORTE`.

### Diretta autonoma (musica dal server)

Dal pannello, conduttori e amministratori possono mandare in onda la musica della libreria del server
**al posto della regia**. Precedenza: diretta esterna, poi diretta autonoma, poi regia. La coda si sceglie dal
pannello; con la coda vuota il ponte sceglie a caso, senza ripetere troppo presto lo stesso brano o artista.
Dal pannello si possono anche caricare brani dal telefono (finiscono in `musica/caricati/`). Inizio e fine
della diretta autonoma arrivano come notifica.

La stessa libreria serve alla **musica di riserva**, che parte da sola quando non c'è nessuna diretta.
La musica sta in `/opt/radio-ponte/musica` (montata in `/musica` nei contenitori):

- `musica/regia/...`: la selezione della libreria della regia. La prima copia si fa a mano: nella regia,
  scheda Collegamento → "Copia la selezione su disco…" su un disco USB, poi sul server
  ```bash
  sudo rsync -a --info=progress2 /media/<disco>/regia/ /opt/radio-ponte/musica/regia/
  sudo chown -R 1000:1000 /opt/radio-ponte/musica
  ```
  Dopo, la regia invia via internet solo i brani nuovi o cambiati (di notte, con un limite di MB al giorno)
  e toglie quelli usciti dalla selezione; manda anche titoli corretti e volume misurato.
- `musica/caricati/`: i brani caricati dal pannello.

Il ponte rilegge la cartella ogni 30 minuti e ogni volta che la regia controlla la libreria. I brani sotto
i 60 secondi (jingle, spot) non vengono scelti a caso. Con la libreria vuota la musica di riserva è silenzio.

**Spazio su disco**: la selezione occupa circa 100 GB. `crea-vm.sh` crea dischi da 300 GB. Per
ingrandire una VM già creata (esempio VM 210, +150 GB), sul nodo Proxmox e poi nella VM:

```bash
qm resize 210 scsi0 +150G          # sul nodo Proxmox
sudo growpart /dev/sda 1 && sudo resize2fs /dev/sda1   # nella VM
df -h /                            # controlla lo spazio
```

### Annunci vocali del server

Menu **☰ → Annunci vocali** (amministratori): annunci a orario con la voce sintetica (sherpa-onnx 1.13.8, voci
piper Paola o Riccardo), solo quando trasmette il server (diretta autonoma o riserva). Le voci si scaricano dal
pannello in `DATA_DIR/voci` (dal rilascio `tts-models` di sherpa-onnx su GitHub); gli MP3 pronti finiscono in
`MUSIC_DIR/.annunci/` (la libreria ignora le cartelle che iniziano col punto) e se ne tengono gli ultimi 200.
Impostazioni in `DATA_DIR/annunci.json`. L'immagine del controllo è ora `node:24-bookworm-slim` (Debian, serve
glibc per sherpa-onnx): dopo l'aggiornamento esegui `riavvia.sh` per ricostruirla.

### Dirette video (YouTube, Facebook)

Dal pannello, sezione **Dirette video**, un conduttore avvia e ferma la diretta quando serve, verso YouTube,
Facebook o entrambi. L'audio è il programma del ponte; l'immagine è a scelta:

- **Logo fisso**: un'immagine PNG o JPEG caricata dal pannello, trasmessa a 1280×720 (15 fotogrammi al
  secondo, circa 1,5 Mbit/s in upload per destinazione). Pochissimo lavoro per il server.
- **Video da OBS**: OBS (con la webcam o quello che vuoi) manda il video al ponte in SRT sulla porta UDP
  `VIDEO_OBS_PORTA` (9020); il ponte lo inoltra **così com'è**, senza ricodificarlo, insieme all'audio della radio.
  In OBS: Impostazioni → Stream → Servizio "Personalizzato", Server `srt://<dominio>:9020`
  (con `?passphrase=...` se hai impostato `VIDEO_OBS_PASSPHRASE`), chiave vuota; Uscita: codificatore x264,
  risoluzione **1280×720 al massimo**, intervallo dei fotogrammi chiave 2 s, 2500-4000 kbit/s.
  Prima premi Avvia nel pannello, poi "Avvia trasmissione" in OBS. Se OBS manda più di 720p il ponte si ferma
  e lo dice. Con OBS in casa basta l'IP del server nella rete locale, senza aprire la porta sul router.
  Se l'audio non è allineato al video, regola il ritardo nelle impostazioni (millisecondi, anche negativo).

Le chiavi di YouTube (YouTube Studio → Trasmetti dal vivo) e di Facebook (Live Producer → chiave di streaming)
le inserisce un amministratore nelle impostazioni della sezione; restano sul server e non si vedono più nel pannello.
Se la diretta cade il ponte riprova da solo (fino a 5 volte di seguito) e manda una notifica.
`DIRETTE_VIDEO=no` toglie la sezione.

## Dirette esterne

Nell'app che usavi per collegarti come DJ ad AzuraCast (BUTT, Larix, Luci Live o simili, in modalità Icecast)
metti:

- **server**: il dominio; **porta**: `ESTERNA_PORTA` (9010);
- **mount**, **utente** e **password**: `ESTERNA_MOUNT`, `ESTERNA_UTENTE`, `ESTERNA_PASSWORD`.

Quando l'app si collega, il ponte passa alla diretta esterna con una breve dissolvenza; quando si scollega
torna alla regia (o alla musica di riserva). Le due cose arrivano anche come notifica. Nel frattempo la regia
può restare accesa: il suo audio arriva al ponte ma non va in onda.

Durante l'esterna il servizio di controllo ascolta il programma (flusso interno di Liquidsoap) e riconosce i
brani con le impronte audio mandate dalla regia (cartella dati `impronte/`); quelli riconosciuti vanno nel
registro del server come "esterna". I tratti non riconosciuti di almeno un minuto finiscono in `sconosciuti/`
(20 secondi di audio + impronta), da etichettare nel pannello. `RICONOSCIMENTO=no` lo spegne.
Memoria: con 20.000 brani l'indice delle impronte occupa circa 300 MB.

## Allarmi

| Allarme | Quando |
|---|---|
| Regia scollegata | il ponte non riceve audio dalla regia da `ALLARME_SCOLLEGATO_SECONDI` (in onda va la musica di riserva, o la diretta esterna/autonoma: il messaggio lo dice) |
| Regia muta | la regia non dà segni di vita da `ALLARME_REGIA_MUTA_SECONDI` (PC spento, programma chiuso) |
| Silenzio | la regia è collegata ma manda silenzio da `ALLARME_SILENZIO_SECONDI` |
| Collegamento instabile | più di `ALLARME_RICONNESSIONI` riconnessioni in 10 minuti |
| Icecast principale | il ponte non riesce a trasmettere all'Icecast principale |
| Icecast secondario | il ponte non riesce a trasmettere all'Icecast esterno (indirizzo, mount o password sbagliati, server spento) |
| Diretta video | la diretta su YouTube/Facebook si è interrotta o non riesce a ripartire |

Quando il problema si risolve arriva un secondo messaggio.

## Backup

Ogni giorno, all'ora scelta nella regia, il ponte riceve una copia del database (libreria, eventi, registro,
impostazioni). Ne tiene `BACKUP_DA_TENERE` (14 di base) nel volume Docker `radio-ponte_dati`.
Per ripristinarne uno: regia → **Collegamento** → **Mostra i backup sul ponte** → **Ripristina**.
La regia si riavvia e conserva il database precedente in un file a parte nella sua cartella dati.

## Aggiornare

```bash
cd /opt/radio-ponte
# copia i file nuovi della cartella ponte, poi
sudo ./riavvia.sh
```

Se il tuo `.env` è di una versione con AzuraCast, aggiungi le righe nuove di `.env.esempio`
(`DOMINIO`, `ICECAST_*`, `VIDEO_*`) e togli quelle `AZURACAST_*`, oppure rilancia `installa-server.sh`
dopo aver spostato il vecchio `.env`.

## Impostazioni dal pannello

Tutti i valori del `.env` (tranne `PANNELLO_ADMIN_PASSWORD`, che serve solo al primo avvio) si vedono e si cambiano
dal pannello: menu ☰ → **Impostazioni server**, solo amministratori.

- Il servizio di controllo monta `.env` in `/impostazioni/.env` e lo riscrive sul posto conservando commenti e ordine
  (valori con spazi o `$` tra apici singoli). Per questo `riavvia.sh` lo assegna all'utente 1000 (resta `600`).
- Dopo il salvataggio lascia il file `richieste/applica`. Il servizio di sistema `radio-ponte-impostazioni.path`
  (installato da `installa-server.sh`, file in `sistema/`) lo vede e lancia `sistema/applica-impostazioni.sh`, cioè
  `docker compose up -d`: ripartono solo i contenitori con valori cambiati. L'esito va in `richieste/esito.json`.
- Liquidsoap riceve solo i suoi valori (elenco in `docker-compose.yml`): cambiare Telegram, email o le altre
  impostazioni del solo servizio di controllo non ferma l'audio.
- Dominio, porte, frase SRT, token, password di Icecast e mount sono "avanzati": si sbloccano con
  **Modifica avanzata** e una doppia conferma.
- Controllo a mano: `systemctl status radio-ponte-impostazioni.path` e `journalctl -u radio-ponte-impostazioni`.

## Problemi comuni

- **"Il ponte non risponde"** nella regia: porta UDP chiusa nel firewall, indirizzo sbagliato, o ponte spento (`docker compose ps`).
- **"Frase segreta errata"**: `SRT_PASSPHRASE` diversa tra `.env` e regia.
- **"token del ponte errato"**: `CONTROLLO_TOKEN` diverso.
- **Il pannello non si apre in https**: il dominio non punta all'IP di casa o le porte 80/443 non arrivano alla VM; guarda `docker compose logs caddy`.
- **Allarme Icecast secondario**: controlla host, porta, mount, utente e password `ICECAST_ESTERNO_*`.
- **L'app delle esterne non si collega**: porta 9010 non inoltrata sul router, o mount/utente/password diversi da `.env`.
  Alcune app vogliono il mount con la barra iniziale (`/`), altre senza: prova entrambi.
- **Il microfono del pannello si apre ma non si sente / si chiude dopo 20 secondi**: porte UDP `WEBRTC_PORTE` non inoltrate; controlla anche `docker compose logs controllo` (righe `[microfono]`).
- **Diretta video "in attesa del video da OBS"**: OBS non arriva alla porta UDP 9020 (indirizzo, porta o frase segreta); le righe `[video]` di `docker compose logs controllo` dicono il motivo.
