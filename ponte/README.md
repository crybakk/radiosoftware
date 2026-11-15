# Ponte di Radio Regia: installazione sul server

Il ponte riceve il programma dalla regia (anche dietro NAT 4G), lo passa nel processore audio e lo manda
ad AzuraCast come se fosse un DJ in diretta. Se la regia si scollega, AzuraCast torna da solo alla sua
AutoDJ di riserva; quando la regia si ricollega, la diretta riprende senza fare niente.

```
Regia (Windows, 4G) ──SRT/UDP──▶ Ponte (Liquidsoap) ──DJ/Icecast──▶ AzuraCast ──▶ ascoltatori
        └──────HTTP + token────▶ Controllo (allarmi, titoli, backup)
App per le esterne ──Icecast──▶ Ponte (ha la precedenza sulla regia finché è collegata)
```

Verso AzuraCast il DJ collegato è sempre e solo il ponte. Le dirette in esterna non si collegano più ad
AzuraCast ma al ponte, che le manda in onda al posto della regia e, quando finiscono, torna alla regia da solo.

## Installazione rapida su Proxmox (VM nuova)

1. Copia `proxmox/crea-vm.sh` sul nodo Proxmox ed eseguilo come root: `bash crea-vm.sh`.
   Crea una VM Ubuntu 24.04 con 4 core, 8 GB di RAM e 300 GB di disco (la selezione della libreria per la diretta autonoma occupa circa 100 GB), che parte da sola insieme a Proxmox.
   Per indirizzo fisso, storage o dimensioni diverse: `IP=192.168.1.50/24 GATEWAY=192.168.1.1 STORAGE=local-lvm DISCO=200G bash crea-vm.sh`.
2. Entra nella VM (`ssh radio@<indirizzo>`), copia la cartella `ponte` ed esegui `sudo bash installa-server.sh`.
   Installa AzuraCast con l'installatore ufficiale e poi il ponte, genera frase segreta, token e password,
   e alla fine stampa i valori da inserire nella regia e le porte da aprire sul router.
3. Completa i punti 1 e 4 qui sotto (account DJ in AzuraCast, impostazioni della regia).

Le sezioni seguenti spiegano gli stessi passaggi a mano, per esempio su un server già esistente.

## Cosa serve

- Il server dove gira AzuraCast, con Docker e Docker Compose (AzuraCast li usa già).
- Porte da aprire nel firewall del server (e da inoltrare sul router, se il server è in casa):
  - **UDP 9000** (`SRT_PORT`) per l'audio dalla regia;
  - **TCP 9080** (`CONTROLLO_PORTA`) per allarmi, titoli, backup e pannello remoto;
  - **TCP 9010** (`ESTERNA_PORTA`) per le dirette esterne;
  - **UDP 40000-40049** (`WEBRTC_PORTE`) per il microfono dal pannello remoto.

  Non usare porte tra 8000 e 8496: AzuraCast le riserva alle sue stazioni.

## 1. In AzuraCast: account DJ per il ponte

1. Apri la stazione → **Profilo** → **Modifica profilo** → scheda **Streamer/DJ**: attiva
   "Permetti agli streamer/DJ di trasmettere" e annota la **porta DJ** (di solito 8005) e il **mount** (di solito `/`).
2. Vai su **Streamer/DJ** → **Aggiungi streamer**: crea per esempio l'utente `ponte` con una password.

Sono gli stessi dati che oggi usa RadioDJ. Solo una sorgente alla volta può collegarsi come DJ:
quando il ponte è in funzione, **togli la diretta da RadioDJ**.

## 2. Copia i file e compila le impostazioni

Sul server, in una cartella a scelta (per esempio `/opt/radio-ponte`), copia la cartella `ponte` di questo repository, poi:

```bash
cd /opt/radio-ponte
cp .env.esempio .env
nano .env
```

Valori da compilare (le spiegazioni sono nel file):

| Variabile | Cosa mettere |
|---|---|
| `NOME_RADIO` | Nome della radio (compare nelle notifiche) |
| `SRT_PASSPHRASE` | Frase segreta da 10 a 79 caratteri, da inserire uguale nella regia |
| `CONTROLLO_TOKEN` | Token lungo e casuale, da inserire uguale nella regia. Si può generare con `openssl rand -hex 24` |
| `PANNELLO_ADMIN_PASSWORD` | Password dell'utente `admin` del pannello remoto (almeno 8 caratteri) |
| `AZURACAST_HOST` | `host.docker.internal` se AzuraCast è sullo stesso server |
| `AZURACAST_PORTA_DJ`, `AZURACAST_MOUNT_DJ` | Porta DJ e mount del punto 1 |
| `AZURACAST_DJ_UTENTE`, `AZURACAST_DJ_PASSWORD` | Account streamer del punto 1 |
| `ESTERNA_PASSWORD` | Password per l'app delle dirette esterne (vuota = ingresso spento) |
| `TELEGRAM_*`, `SMTP_*`, `EMAIL_*` | Facoltativi: dove ricevere gli allarmi |

## 3. Avvio

```bash
sudo ./riavvia.sh           # avvia (e in seguito riavvia/aggiorna) il ponte
docker compose logs -f      # per controllare (Ctrl+C per uscire)
```

I servizi ripartono da soli dopo un riavvio del server.

Apri nel firewall le porte (esempio con `ufw`):

```bash
sudo ufw allow 9000/udp
sudo ufw allow 9080/tcp
sudo ufw allow 9010/tcp
sudo ufw allow 40000:40049/udp
```

Se il server è presso un provider con firewall esterno (pannello web), apri le stesse porte anche lì.

## 4. Nella regia

Scheda **Collegamento**:

- **Indirizzo del server**: lo stesso che usi per AzuraCast (es. `radio.esempio.it`), senza `https://`.
- **Porta SRT**, **Frase segreta**, **Porta** e **Token del servizio di controllo**: gli stessi valori del file `.env`.
- **Cosa inviare**: "Solo il programma del computer" manda musica, jingle ed eventi della regia.
  Se i microfoni passano dal RodeCaster, scegli "Un ingresso della scheda audio" e l'ingresso del RodeCaster
  con il mix principale, così in diretta va anche la voce.
- **Salva**, poi **Accendi invio**. La spia in alto a destra diventa verde ("PONTE: OK").

Con **Invia notifica di prova** controlli che Telegram o l'email arrivino.

## Pannello remoto

Dal browser (telefono, tablet o computer) apri `http://<indirizzo del server>:9080`
(`https://` se il pannello usa il certificato di AzuraCast, vedi sotto) ed entra con l'utente `admin`
e la password `PANNELLO_ADMIN_PASSWORD` del file `.env`.

Dal pannello vedi cosa va in onda e la coda, e puoi premere PLAY / AVANTI / STOP, passare tra automatico e
manuale, cercare un brano e metterlo in coda, far partire i jingle. Funziona anche con la regia dietro il 4G:
è la regia ad aprire il collegamento verso il ponte.

Ruoli (menu ☰ → Utenti, solo per gli amministratori):

| Ruolo | Cosa può fare |
|---|---|
| Amministratore | tutto, compresa la gestione degli utenti |
| Conduttore | comandare la regia e usare il microfono dal pannello |
| Ospite | vedere soltanto, senza microfono (il collegamento audio degli ospiti arriva con la fase 5) |

### Microfono dal pannello

Conduttori e amministratori possono aprire il microfono dal pannello (WebRTC, Opus). La voce arriva al
servizio di controllo, che la passa a Liquidsoap sulla rete interna (RTP, UDP 41030); quando il conduttore
preme VAI IN ONDA la musica si abbassa di `ABBASSAMENTO_MUSICA_DB` e la voce entra nel mixer prima del
processore audio. Liquidsoap rimanda al conduttore il programma senza la sua voce (UDP 41040, interno).

- Serve il pannello in **HTTPS** (i browser danno il microfono solo alle pagine protette).
- Inoltra sul router le porte **UDP `WEBRTC_PORTE`** (predefinite 40000-40049) verso il server.
- Il ponte annuncia al browser l'indirizzo del nome con cui è stato aperto il pannello, più quelli in
  `WEBRTC_INDIRIZZI` (l'installazione ci mette l'IP del server nella rete di casa).
- Un microfono alla volta; se il conduttore si scollega la voce esce dall'onda da sola.
- La voce va in onda solo quando c'è un programma (regia o esterna): senza, l'uscita verso AzuraCast resta
  ferma e AzuraCast usa la sua AutoDJ.
- `MICROFONO_REMOTO=no` lo disattiva.

### Diretta autonoma (musica dal server)

Dal pannello, conduttori e amministratori possono mandare in onda la musica della libreria del server
**al posto della regia** (per esempio quando la regia è spenta). Precedenza: diretta esterna, poi diretta
autonoma, poi regia. La coda si sceglie dal pannello; con la coda vuota il ponte sceglie a caso, senza
ripetere troppo presto lo stesso brano o artista. Dal pannello si possono anche caricare brani dal telefono
(finiscono in `musica/caricati/`). Inizio e fine della diretta autonoma arrivano come notifica.

La musica sta in `/opt/radio-ponte/musica` (montata in `/musica` nei due contenitori):

- `musica/regia/...`: la selezione della libreria della regia. La prima copia si fa a mano: nella regia,
  scheda Collegamento → "Copia la selezione su disco…" su un disco USB, poi sul server
  ```bash
  sudo rsync -a --info=progress2 /media/<disco>/regia/ /opt/radio-ponte/musica/regia/
  sudo chown -R 1000:1000 /opt/radio-ponte/musica
  ```
  Dopo, la regia invia via internet solo i brani nuovi o cambiati (di notte, con un limite di MB al giorno)
  e toglie quelli usciti dalla selezione; manda anche titoli corretti e volume misurato.
- `musica/caricati/`: i brani caricati dal pannello.

Il ponte rilegge la cartella ogni 30 minuti e ogni volta che la regia controlla la libreria.

**Spazio su disco**: la selezione occupa circa 100 GB. `crea-vm.sh` ora crea dischi da 300 GB. Per
ingrandire una VM già creata (esempio VM 210, +150 GB), sul nodo Proxmox e poi nella VM:

```bash
qm resize 210 scsi0 +150G          # sul nodo Proxmox
sudo growpart /dev/sda 1 && sudo resize2fs /dev/sda1   # nella VM
df -h /                            # controlla lo spazio
```

### HTTPS

Se AzuraCast è sullo stesso server e ha un certificato Let's Encrypt (nome di dominio impostato in
AzuraCast → Amministrazione → Impostazioni di sistema), il ponte usa lo stesso certificato e il pannello
diventa `https://`. Lo fa da solo `riavvia.sh`: lancialo dopo aver attivato il certificato in AzuraCast.

```bash
sudo /opt/radio-ponte/riavvia.sh
```

Nella regia, scheda Collegamento, spunta allora "Il servizio di controllo usa HTTPS" e usa il nome di
dominio come indirizzo del server.

## Dirette esterne

Nell'app che usavi per collegarti come DJ ad AzuraCast (BUTT, Larix, Luci Live o simili, in modalità Icecast)
cambia soltanto:

- **porta**: `ESTERNA_PORTA` (9010) invece della porta DJ di AzuraCast;
- **mount**, **utente** e **password**: `ESTERNA_MOUNT`, `ESTERNA_UTENTE`, `ESTERNA_PASSWORD`.

Quando l'app si collega, il ponte passa alla diretta esterna con una breve dissolvenza; quando si scollega
torna alla regia. Le due cose arrivano anche come notifica. Nel frattempo la regia può restare accesa: il suo
audio arriva al ponte ma non va in onda.

## Allarmi

| Allarme | Quando |
|---|---|
| Regia scollegata | il ponte non riceve audio dalla regia da `ALLARME_SCOLLEGATO_SECONDI` (se è in onda una diretta esterna, il messaggio lo dice) |
| Regia muta | la regia non dà segni di vita da `ALLARME_REGIA_MUTA_SECONDI` (PC spento, programma chiuso) |
| Silenzio | la regia è collegata ma manda silenzio da `ALLARME_SILENZIO_SECONDI` |
| Collegamento instabile | più di `ALLARME_RICONNESSIONI` riconnessioni in 10 minuti |
| AzuraCast | il ponte non riesce a collegarsi ad AzuraCast (password o porta DJ sbagliate) |

Quando il problema si risolve arriva un secondo messaggio.

## Backup

Ogni giorno, all'ora scelta nella regia, il ponte riceve una copia del database (libreria, eventi, registro,
impostazioni). Ne tiene `BACKUP_DA_TENERE` (14 di base) nel volume Docker `radio-ponte_dati`.
Per ripristinarne uno: regia → **Collegamento** → **Mostra i backup sul ponte** → **Ripristina**.
La regia si riavvia e conserva il database precedente in un file a parte nella sua cartella dati.

## Aggiornare il ponte

```bash
cd /opt/radio-ponte
# copia i file nuovi della cartella ponte, poi
sudo ./riavvia.sh
```

## Problemi comuni

- **"Il ponte non risponde"** nella regia: porta UDP chiusa nel firewall, indirizzo sbagliato, o ponte spento (`docker compose ps`).
- **"Frase segreta errata"**: `SRT_PASSPHRASE` diversa tra `.env` e regia.
- **"token del ponte errato"**: `CONTROLLO_TOKEN` diverso.
- **Allarme AzuraCast**: controlla utente, password, porta e mount del DJ, e che RadioDJ non sia ancora collegato.
- **L'app delle esterne non si collega**: porta 9010 non inoltrata sul router, o mount/utente/password diversi da `.env`.
- **Il microfono del pannello si apre ma non si sente / si chiude dopo 20 secondi**: porte UDP `WEBRTC_PORTE` non inoltrate; controlla anche `docker compose logs controllo` (righe `[microfono]`).
  Alcune app vogliono il mount con la barra iniziale (`/`), altre senza: prova entrambi.
