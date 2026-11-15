#!/usr/bin/env bash
# Installa il server della radio su Ubuntu 24.04 (la VM creata con proxmox/crea-vm.sh):
# ponte di Radio Regia, Icecast principale e Caddy (HTTPS automatico con Let's Encrypt).
# Da eseguire nella cartella "ponte", come root:
#
#   sudo DOMINIO=radio.esempio.it bash installa-server.sh
#
# Si può rilanciare senza rischi: salta quello che è già installato e non tocca un .env esistente.
set -euo pipefail

CARTELLA_PONTE="/opt/radio-ponte"
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

passo "Docker"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -q docker.io docker-compose-v2
fi
systemctl enable --now docker
docker compose version >/dev/null 2>&1 || errore "Docker Compose non risulta installato"

passo "Controllo delle porte 80 e 443 (servono a Caddy per l'HTTPS)"
if [[ -f /var/azuracast/docker-compose.yml ]]; then
  errore "su questo server c'è ancora AzuraCast, che usa le porte 80 e 443. Toglilo prima (cd /var/azuracast && ./docker.sh uninstall) oppure usa una VM nuova"
fi
if ss -ltn '( sport = :80 or sport = :443 )' | grep -q LISTEN && ! docker ps --format '{{.Names}}' | grep -q '^radio-ponte-caddy'; then
  errore "le porte 80 o 443 sono già usate da un altro programma: liberale prima di continuare"
fi

passo "Ponte: copio i file in $CARTELLA_PONTE"
mkdir -p "$CARTELLA_PONTE"
rsync -a --exclude .env --exclude proxmox --exclude musica "$QUI/" "$CARTELLA_PONTE/"
cd "$CARTELLA_PONTE"

NUOVO_ENV=0
if [[ ! -f .env ]]; then
  NUOVO_ENV=1
  DOMINIO="${DOMINIO:-}"
  if [[ -z "$DOMINIO" ]]; then
    read -r -p "Nome di dominio della radio (es. radio.esempio.it): " DOMINIO
  fi
  [[ "$DOMINIO" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || errore "nome di dominio non valido: $DOMINIO"
  cp .env.esempio .env
  chmod 600 .env
  imposta() { sed -i "s|^$1=.*|$1=$2|" .env; }
  imposta DOMINIO "$DOMINIO"
  imposta SRT_PASSPHRASE "$(openssl rand -hex 16)"
  imposta CONTROLLO_TOKEN "$(openssl rand -hex 24)"
  imposta ESTERNA_PASSWORD "$(openssl rand -hex 8)"
  imposta ICECAST_PASSWORD_SORGENTE "$(openssl rand -hex 12)"
  imposta ICECAST_PASSWORD_ADMIN "$(openssl rand -hex 12)"
  imposta PANNELLO_ADMIN_PASSWORD "$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)"
  # il microfono remoto funziona anche dalla rete di casa
  imposta WEBRTC_INDIRIZZI "$(hostname -I | awk '{print $1}')"
  echo "Creato .env con dominio, frase segreta, token e password generati a caso."
else
  echo ".env esistente: non lo modifico."
  grep -q '^DOMINIO=' .env || errore "nel file .env manca DOMINIO=… (la versione nuova non usa più AzuraCast: vedi .env.esempio)"
fi

passo "Avvio"
./riavvia.sh

leggi() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
IP_LOCALE="$(hostname -I | awk '{print $1}')"
DOM="$(leggi DOMINIO)"

cat <<FINE

============================================================
 Installazione completata
============================================================

1) Sul router, inoltra verso $IP_LOCALE:
     TCP 80 e 443              (HTTPS: pannello, regia, ascolto)
     TCP $(leggi ICECAST_PORTA)                  (ascolto senza https, facoltativo)
     UDP $(leggi SRT_PORT)                  (audio dalla regia)
     TCP $(leggi ESTERNA_PORTA)                  (dirette esterne)
     UDP $(leggi WEBRTC_PORTE)      (microfono remoto e ospiti)
     UDP $(leggi VIDEO_OBS_PORTA)                  (video da OBS, solo se lo usi)
   Il nome $DOM deve puntare all'IP pubblico di casa. Caddy chiede il certificato
   da solo appena le porte 80 e 443 sono raggiungibili (controlla con: docker compose logs caddy).

2) Nella regia, scheda Collegamento:
     Indirizzo del server:   $DOM
     Porta SRT:              $(leggi SRT_PORT)
     Frase segreta:          $(leggi SRT_PASSPHRASE)
     Porta controllo:        443
     Token:                  $(leggi CONTROLLO_TOKEN)
     HTTPS:                  sì

3) Pannello remoto: https://$DOM
     utente: admin   password: $(leggi PANNELLO_ADMIN_PASSWORD)

4) Ascolto della radio: https://$DOM$(leggi ICECAST_MOUNT)
   Amministrazione di Icecast: http://$DOM:$(leggi ICECAST_PORTA)/admin/  (utente admin, password ICECAST_PASSWORD_ADMIN nel .env)

5) Dirette esterne: nell'app che usavi come DJ su AzuraCast metti
     server $DOM, porta $(leggi ESTERNA_PORTA), mount $(leggi ESTERNA_MOUNT), utente $(leggi ESTERNA_UTENTE), password $(leggi ESTERNA_PASSWORD)

6) Icecast secondario (esterno): scrivi i suoi dati in $CARTELLA_PONTE/.env
   (ICECAST_ESTERNO_...) e poi: sudo $CARTELLA_PONTE/riavvia.sh

7) Musica di riserva e diretta autonoma: copia la selezione della libreria in
   $CARTELLA_PONTE/musica (vedi la guida, "Libreria sul server").

Questi valori restano in $CARTELLA_PONTE/.env (sudo cat $CARTELLA_PONTE/.env).
FINE
[[ $NUOVO_ENV -eq 1 ]] && echo "Conserva frase segreta e token: servono per collegare la regia."
exit 0
