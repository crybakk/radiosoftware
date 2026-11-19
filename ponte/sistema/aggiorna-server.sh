#!/usr/bin/env bash
# Aggiorna il server alla versione chiesta dal pannello ("Aggiorna server"): scarica lo ZIP della release
# da GitHub, controlla l'impronta e rilancia installa-server.sh dalla versione nuova (le impostazioni restano).
# Lo lancia il servizio radio-ponte-aggiorna quando il pannello lascia la richiesta richieste/aggiorna.
# Scrive l'esito in richieste/esito-aggiornamento.json per il pannello.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="crybakk/radiosoftware"

# la richiesta arriva dal servizio di controllo: qui (come root) si legge solo un numero di versione
versione=$(head -c 40 richieste/aggiorna 2>/dev/null | tr -d '[:space:]')
rm -f richieste/aggiorna
# richieste/ è scrivibile dal servizio di controllo: niente touch (seguirebbe un collegamento simbolico
# e creerebbe un file come root dove vuole lui), si crea un file nuovo e lo si sposta al suo posto
segno=$(mktemp -p .)
chmod 644 "$segno"
mv -fT "$segno" richieste/aggiornamento-in-corso
lavoro=$(mktemp -d)
trap 'rm -rf "$lavoro"; rm -f richieste/aggiornamento-in-corso' EXIT

esito() {
  local ok="$1" messaggio="$2" nuovo
  nuovo=$(mktemp -p .)
  python3 - "$ok" "$messaggio" > "$nuovo" <<'PY'
import json, sys
from datetime import datetime, timezone
print(json.dumps({'quando': datetime.now(timezone.utc).isoformat(), 'ok': sys.argv[1] == '1', 'messaggio': sys.argv[2][:500]}))
PY
  chmod 644 "$nuovo"
  chown 1000:1000 "$nuovo" 2>/dev/null || true
  # mv sostituisce un eventuale collegamento simbolico invece di seguirlo
  mv -fT "$nuovo" richieste/esito-aggiornamento.json
}
fallito() { echo "ERRORE: $*" >&2; esito 0 "Aggiornamento non riuscito: $*"; exit 1; }

[[ "$versione" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fallito "versione non valida"
echo "Aggiorno il server alla versione $versione"
base="https://github.com/$REPO/releases/download/v$versione"
zip="RadioPonte-server-$versione.zip"
curl -fsSL --retry 3 -o "$lavoro/$zip" "$base/$zip" || fallito "non riesco a scaricare $zip"
curl -fsSL --retry 3 -o "$lavoro/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || fallito "non riesco a scaricare SHA256SUMS.txt"
(cd "$lavoro" && grep " $zip\$" SHA256SUMS.txt | sha256sum -c --status -) || fallito "lo ZIP scaricato non corrisponde all'impronta"
command -v unzip >/dev/null || apt-get install -y -q unzip >/dev/null || fallito "manca unzip"
unzip -q "$lavoro/$zip" -d "$lavoro/x" || fallito "ZIP non leggibile"
script="$lavoro/x/radio-ponte-$versione/ponte/installa-server.sh"
[[ -f "$script" ]] || fallito "nello ZIP manca installa-server.sh"
uscita=$(bash "$script" 2>&1)
codice=$?
echo "$uscita"
if [[ $codice -ne 0 ]]; then
  fallito "installazione finita con errore: $(echo "$uscita" | grep -v '^\s*$' | tail -n 2 | tr '\n' ' ')"
fi
esito 1 "Server aggiornato alla versione $versione"
