#!/usr/bin/env bash
# Installa AzuraCast e il ponte di Radio Regia su Ubuntu 24.04 (la VM creata con proxmox/crea-vm.sh).
# Da eseguire nella cartella "ponte", come root:
#
#   sudo bash installa-server.sh
#
# Si può rilanciare senza rischi: salta quello che è già installato e non tocca un .env esistente.
set -euo pipefail

CARTELLA_PONTE="/opt/radio-ponte"
CARTELLA_AZURACAST="/var/azuracast"
QUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

errore() { echo "ERRORE: $*" >&2; exit 1; }
passo() { echo; echo "==> $*"; }

[[ $EUID -eq 0 ]] || errore "esegui con sudo"
[[ -f "$QUI/docker-compose.yml" && -f "$QUI/.env.esempio" ]] || errore "esegui lo script dalla cartella 'ponte' del progetto"

passo "Sistema: fuso orario, aggiornamenti, agente Proxmox"
timedatectl set-timezone Europe/Rome
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q qemu-guest-agent curl openssl rsync unattended-upgrades
systemctl enable --now qemu-guest-agent || true

passo "AzuraCast"
if [[ -f "$CARTELLA_AZURACAST/docker-compose.yml" ]]; then
  echo "AzuraCast è già installato in $CARTELLA_AZURACAST: lo lascio com'è."
else
  echo "Parte l'installatore ufficiale di AzuraCast: rispondi alle domande (vanno bene le risposte proposte)."
  mkdir -p "$CARTELLA_AZURACAST"
  cd "$CARTELLA_AZURACAST"
  curl -fsSL https://raw.githubusercontent.com/AzuraCast/AzuraCast/main/docker.sh > docker.sh
  chmod a+x docker.sh
  ./docker.sh install
fi
command -v docker >/dev/null || errore "Docker non risulta installato: controlla l'installazione di AzuraCast"

passo "Ponte: copio i file in $CARTELLA_PONTE"
mkdir -p "$CARTELLA_PONTE"
rsync -a --exclude .env --exclude proxmox "$QUI/" "$CARTELLA_PONTE/"
cd "$CARTELLA_PONTE"

NUOVO_ENV=0
if [[ ! -f .env ]]; then
  NUOVO_ENV=1
  cp .env.esempio .env
  chmod 600 .env
  imposta() { sed -i "s|^$1=.*|$1=$2|" .env; }
  imposta SRT_PASSPHRASE "$(openssl rand -hex 16)"
  imposta CONTROLLO_TOKEN "$(openssl rand -hex 24)"
  imposta ESTERNA_PASSWORD "$(openssl rand -hex 8)"
  imposta PANNELLO_ADMIN_PASSWORD "$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)"
  # il microfono remoto funziona anche dalla rete di casa
  imposta WEBRTC_INDIRIZZI "$(hostname -I | awk '{print $1}')"
  echo "Creato .env con frase segreta, token e password delle esterne generati a caso."
else
  echo ".env esistente: non lo modifico."
fi

passo "Ponte: avvio"
# riavvia.sh: riavvia il ponte e attiva l'HTTPS appena AzuraCast ha un certificato Let's Encrypt
./riavvia.sh
HTTPS_ATTIVO=0
grep -q '^# https attivo' .stato-https 2>/dev/null && HTTPS_ATTIVO=1

leggi() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
IP_LOCALE="$(hostname -I | awk '{print $1}')"

cat <<FINE

============================================================
 Installazione completata
============================================================

1) AzuraCast: apri http://$IP_LOCALE nel browser e completa la configurazione
   (account amministratore, stazione). Se stai spostando la radio dal vecchio
   server, puoi ripristinare un backup di AzuraCast da Amministrazione → Backup.

2) In AzuraCast crea l'account DJ per il ponte (Profilo → Streamer/DJ), poi
   scrivi utente e password in $CARTELLA_PONTE/.env:
     AZURACAST_DJ_UTENTE=...
     AZURACAST_DJ_PASSWORD=...
   e riavvia il ponte:
     sudo $CARTELLA_PONTE/riavvia.sh

3) Nella regia, scheda Collegamento:
     Indirizzo del server:   il tuo indirizzo pubblico o nome di dominio
     Porta SRT:              $(leggi SRT_PORT)
     Frase segreta:          $(leggi SRT_PASSPHRASE)
     Porta controllo:        $(leggi CONTROLLO_PORTA)
     Token:                  $(leggi CONTROLLO_TOKEN)
     HTTPS:                  $([[ $HTTPS_ATTIVO -eq 1 ]] && echo "sì (serve il nome di dominio configurato in AzuraCast)" || echo "no")

   Pannello remoto: $([[ $HTTPS_ATTIVO -eq 1 ]] && echo https || echo http)://<indirizzo>:$(leggi CONTROLLO_PORTA)
     utente: admin   password: $(leggi PANNELLO_ADMIN_PASSWORD)

4) Dirette esterne: nell'app che usavi come DJ su AzuraCast cambia solo
     porta $(leggi ESTERNA_PORTA), mount $(leggi ESTERNA_MOUNT), utente $(leggi ESTERNA_UTENTE), password $(leggi ESTERNA_PASSWORD)

5) Sul router, inoltra verso $IP_LOCALE:
     TCP 80 e 443              (pagine di AzuraCast)
     TCP 8000-8006             (ascolto della radio)
     UDP $(leggi SRT_PORT)                  (audio dalla regia)
     TCP $(leggi CONTROLLO_PORTA)                  (allarmi, titoli, backup)
     TCP $(leggi ESTERNA_PORTA)                  (dirette esterne)
     UDP $(leggi WEBRTC_PORTE)      (microfono remoto dal pannello)

Questi valori restano in $CARTELLA_PONTE/.env (sudo cat $CARTELLA_PONTE/.env).
FINE
[[ $NUOVO_ENV -eq 1 ]] && echo "Conserva frase segreta e token: servono per collegare la regia."
exit 0
