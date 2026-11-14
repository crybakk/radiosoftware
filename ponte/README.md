# Ponte di Radio Regia: installazione sul server

Il ponte riceve il programma dalla regia (anche dietro NAT 4G), lo passa nel processore audio e lo manda
ad AzuraCast come se fosse un DJ in diretta. Se la regia si scollega, AzuraCast torna da solo alla sua
AutoDJ di riserva; quando la regia si ricollega, la diretta riprende senza fare niente.

```
Regia (Windows, 4G) ──SRT/UDP──▶ Ponte (Liquidsoap) ──DJ/Icecast──▶ AzuraCast ──▶ ascoltatori
        └──────HTTP + token────▶ Controllo (allarmi, titoli, backup)
```

## Cosa serve

- Il server dove gira AzuraCast, con Docker e Docker Compose (AzuraCast li usa già).
- Due porte libere da aprire nel firewall del server:
  - **UDP 9000** (o quella scelta in `SRT_PORT`) per l'audio dalla regia;
  - **TCP 8090** (o quella scelta in `CONTROLLO_PORTA`) per allarmi, titoli e backup.

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
| `AZURACAST_HOST` | `host.docker.internal` se AzuraCast è sullo stesso server |
| `AZURACAST_PORTA_DJ`, `AZURACAST_MOUNT_DJ` | Porta DJ e mount del punto 1 |
| `AZURACAST_DJ_UTENTE`, `AZURACAST_DJ_PASSWORD` | Account streamer del punto 1 |
| `TELEGRAM_*`, `SMTP_*`, `EMAIL_*` | Facoltativi: dove ricevere gli allarmi |

## 3. Avvio

```bash
docker compose up -d --build
docker compose logs -f      # per controllare (Ctrl+C per uscire)
```

I servizi ripartono da soli dopo un riavvio del server.

Apri nel firewall le due porte (esempio con `ufw`):

```bash
sudo ufw allow 9000/udp
sudo ufw allow 8090/tcp
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

## Allarmi

| Allarme | Quando |
|---|---|
| Regia scollegata | il ponte non riceve audio dalla regia da `ALLARME_SCOLLEGATO_SECONDI` |
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
docker compose up -d --build
```

## Problemi comuni

- **"Il ponte non risponde"** nella regia: porta UDP chiusa nel firewall, indirizzo sbagliato, o ponte spento (`docker compose ps`).
- **"Frase segreta errata"**: `SRT_PASSPHRASE` diversa tra `.env` e regia.
- **"token del ponte errato"**: `CONTROLLO_TOKEN` diverso.
- **Allarme AzuraCast**: controlla utente, password, porta e mount del DJ, e che RadioDJ non sia ancora collegato.
