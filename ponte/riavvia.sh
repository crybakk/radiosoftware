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
  st_tmp=$(mktemp -d -p .)
  # ZIP generico di Thimeo (circa 360 MB) con le librerie per tutti i sistemi. È fatto su Windows (percorsi con
  # la barra rovesciata, unzip esce con un errore): il file giusto lo estrae python. Serve la libreria per Linux
  # Intel/AMD a 64 bit senza X11, non quella della cartella Kantar.
  if curl -fsSL --retry 3 -m 1800 -o "$st_tmp/st.zip" https://download.thimeo.com/Stereo_Tool_Generic_plugin.zip; then
    # si estrae nella cartella temporanea di root e poi si sposta: stereotool/ è scrivibile dal servizio di
    # controllo, che potrebbe metterci un collegamento simbolico al posto del file
    if python3 - "$st_tmp/st.zip" "$st_tmp/libStereoTool.so" <<'PY'
import shutil, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    scelti = []
    for info in z.infolist():
        nome = info.filename.replace('\\', '/')
        parti = [p.lower() for p in nome.split('/')]
        if parti[-1] == 'libstereotool_intel64.so' and 'linux' in parti and 'kantar' not in parti:
            scelti.append((len(parti), info))
    if not scelti:
        sys.exit('nello ZIP non trovo libStereoTool_intel64.so per Linux')
    info = sorted(scelti, key=lambda x: x[0])[0][1]
    with z.open(info) as src, open(sys.argv[2] + '.nuovo', 'wb') as dst:
        shutil.copyfileobj(src, dst)
    print('Libreria di Stereo Tool installata (' + info.filename + ').')
PY
    then
      chmod 644 "$st_tmp/libStereoTool.so.nuovo"
      chown 1000:1000 "$st_tmp/libStereoTool.so.nuovo" 2>/dev/null || true
      # mv -T sostituisce un eventuale collegamento simbolico invece di seguirlo
      mv -fT "$st_tmp/libStereoTool.so.nuovo" stereotool/libStereoTool.so
    else
      echo "Attenzione: non riesco a estrarre Stereo Tool dallo ZIP (riprovo al prossimo riavvio)." >&2
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
