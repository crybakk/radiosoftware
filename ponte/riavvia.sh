#!/usr/bin/env bash
# Riavvia (e aggiorna) il server della radio: ponte, Icecast principale e Caddy (HTTPS automatico).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# libreria musicale del server (diretta autonoma e musica di riserva): scrivibile dal servizio di controllo (utente 1000)
mkdir -p musica richieste
chown 1000:1000 musica richieste 2>/dev/null || true
# password del relay di Icecast: propria, non più uguale a quella di amministrazione (installazioni vecchie)
if [[ -f .env ]] && ! grep -q '^ICECAST_PASSWORD_RELAY=.' .env; then
  sed -i '/^ICECAST_PASSWORD_RELAY=/d' .env
  echo "ICECAST_PASSWORD_RELAY=$(openssl rand -hex 12)" >> .env
fi
# frase segreta del video da OBS (installazioni vecchie): senza, la diretta da OBS non parte
if [[ -f .env ]] && ! grep -q '^VIDEO_OBS_PASSPHRASE=.' .env; then
  sed -i '/^VIDEO_OBS_PASSPHRASE=/d' .env
  echo "VIDEO_OBS_PASSPHRASE=$(openssl rand -hex 16)" >> .env
fi
# il pannello modifica le impostazioni: il file .env deve essere scrivibile dal servizio di controllo (resta privato)
chown 1000:1000 .env 2>/dev/null || true
chmod 600 .env 2>/dev/null || true
# guida d'uso per il pannello (la riempie installa-server.sh)
mkdir -p guida
# il pannello può modificare il .env: niente variabili che cambino i file o il progetto di docker compose
if grep -qE '^[[:space:]]*(export[[:space:]]+)?(COMPOSE_|DOCKER_)' .env 2>/dev/null; then
  echo "Errore: il file .env contiene variabili COMPOSE_ o DOCKER_: toglile e riprova." >&2
  exit 1
fi
docker compose -f docker-compose.yml up -d --build --remove-orphans "$@"
