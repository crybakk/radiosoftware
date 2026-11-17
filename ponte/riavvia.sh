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
# Stereo Tool (processore audio facoltativo): la cartella la legge Liquidsoap, il preset lo scrive il pannello.
# La libreria per Linux 64 bit si scarica una volta dal sito di Thimeo; se non si riesce, la radio parte
# lo stesso (con Stereo Tool scelto si usa il processore "medio" e arriva un allarme).
mkdir -p stereotool
chown 1000:1000 stereotool 2>/dev/null || true
chmod 755 stereotool
if [[ ! -s stereotool/libStereoTool.so ]]; then
  echo "Scarico la libreria di Stereo Tool (Thimeo)…"
  st_tmp=$(mktemp -d)
  if curl -fsSL --retry 3 -m 600 -o "$st_tmp/st.zip" https://download.thimeo.com/Stereo_Tool_Generic_plugin.zip \
    && unzip -q "$st_tmp/st.zip" -d "$st_tmp/x"; then
    # nello ZIP ci sono le librerie per tutti i sistemi: serve quella per Linux, Intel/AMD a 64 bit
    st_libs=$(find "$st_tmp/x" -type f -iname 'libStereoTool*.so' | grep -iv -e arm -e aarch -e pi2 || true)
    st_lib=$(echo "$st_libs" | grep -i linux | grep -e 64 | head -n 1 || true)
    [[ -n "$st_lib" ]] || st_lib=$(echo "$st_libs" | grep -i -e intel64 -e x86_64 -e amd64 | head -n 1 || true)
    if [[ -n "$st_lib" ]]; then
      install -m 644 "$st_lib" stereotool/libStereoTool.so
      echo "Libreria di Stereo Tool installata ($(basename "$st_lib"))."
    else
      echo "Attenzione: nello ZIP di Stereo Tool non trovo la libreria per Linux 64 bit." >&2
    fi
  else
    echo "Attenzione: non riesco a scaricare Stereo Tool (riprovo al prossimo riavvio)." >&2
  fi
  rm -rf "$st_tmp"
fi
# guida d'uso per il pannello (la riempie installa-server.sh)
mkdir -p guida
# il pannello può modificare il .env: niente variabili che cambino i file o il progetto di docker compose
if grep -qE '^[[:space:]]*(export[[:space:]]+)?(COMPOSE_|DOCKER_)' .env 2>/dev/null; then
  echo "Errore: il file .env contiene variabili COMPOSE_ o DOCKER_: toglile e riprova." >&2
  exit 1
fi
docker compose -f docker-compose.yml up -d --build --remove-orphans "$@"
