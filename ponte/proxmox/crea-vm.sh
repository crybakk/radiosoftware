#!/usr/bin/env bash
# Crea su Proxmox la VM del server della radio: ponte di Radio Regia, Icecast e Caddy (Ubuntu 24.04 LTS, cloud-init).
# Da eseguire come root nella shell del nodo Proxmox:
#
#   bash crea-vm.sh
#
# I valori si possono cambiare prima del comando, per esempio:
#   VMID=300 IP=192.168.1.50/24 GATEWAY=192.168.1.1 bash crea-vm.sh
set -euo pipefail

VMID="${VMID:-210}"
NOME="${NOME:-radio}"
CORES="${CORES:-4}"                 # l'N100 ha 4 core: li diamo tutti, Proxmox li condivide
RAM_MB="${RAM_MB:-4096}"            # 4 GB bastano (niente AzuraCast); il resto dei 12 GB resta a Proxmox
DISCO="${DISCO:-300G}"              # sistema + selezione della libreria (diretta autonoma e musica di riserva)
STORAGE="${STORAGE:-local-lvm}"     # dove mettere il disco (vedi "pvesm status")
BRIDGE="${BRIDGE:-vmbr0}"           # scheda di rete di Proxmox
IP="${IP:-dhcp}"                    # "dhcp" oppure indirizzo fisso tipo 192.168.1.50/24
GATEWAY="${GATEWAY:-}"              # obbligatorio con indirizzo fisso, es. 192.168.1.1
UTENTE="${UTENTE:-radio}"           # utente per entrare nella VM
CHIAVE_SSH="${CHIAVE_SSH:-/root/.ssh/authorized_keys}"   # chiavi SSH autorizzate (facoltative)
PASSWORD="${PASSWORD:-}"            # password dell'utente; se vuota la chiede
IMG_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
IMG="/var/tmp/noble-server-cloudimg-amd64.img"

errore() { echo "ERRORE: $*" >&2; exit 1; }

command -v qm >/dev/null || errore "questo script va eseguito sul nodo Proxmox"
[[ $EUID -eq 0 ]] || errore "serve l'utente root"
qm status "$VMID" >/dev/null 2>&1 && errore "esiste già una VM con id $VMID: scegline un altro con VMID=..."
pvesm status | awk 'NR>1 {print $1}' | grep -qx "$STORAGE" || errore "lo storage '$STORAGE' non esiste (vedi 'pvesm status')"
if [[ "$IP" != "dhcp" && -z "$GATEWAY" ]]; then errore "con un indirizzo fisso serve anche GATEWAY=..."; fi

if [[ -z "$PASSWORD" ]]; then
  read -r -s -p "Password per l'utente '$UTENTE' della VM: " PASSWORD; echo
  [[ ${#PASSWORD} -ge 8 ]] || errore "la password deve avere almeno 8 caratteri"
fi

echo "==> Scarico Ubuntu 24.04 LTS (immagine cloud)…"
if [[ ! -s "$IMG" ]] || [[ $(find "$IMG" -mtime +7 2>/dev/null) ]]; then
  wget -q --show-progress -O "$IMG.part" "$IMG_URL"
  mv "$IMG.part" "$IMG"
fi

echo "==> Creo la VM $VMID ($NOME)…"
qm create "$VMID" \
  --name "$NOME" \
  --ostype l26 \
  --machine q35 \
  --cpu host \
  --cores "$CORES" \
  --memory "$RAM_MB" \
  --balloon 0 \
  --net0 "virtio,bridge=$BRIDGE" \
  --scsihw virtio-scsi-single \
  --agent enabled=1 \
  --onboot 1 \
  --startup order=1 \
  --serial0 socket \
  --vga serial0 \
  --description "Server della radio: ponte di Radio Regia, Icecast, Caddy"

# disco di sistema dall'immagine cloud, poi ingrandito
qm set "$VMID" --scsi0 "$STORAGE:0,import-from=$IMG,discard=on,ssd=1,iothread=1"
qm resize "$VMID" scsi0 "$DISCO"
qm set "$VMID" --ide2 "$STORAGE:cloudinit" --boot order=scsi0

# rete e utente con cloud-init
if [[ "$IP" == "dhcp" ]]; then
  qm set "$VMID" --ipconfig0 ip=dhcp
else
  qm set "$VMID" --ipconfig0 "ip=$IP,gw=$GATEWAY"
fi
qm set "$VMID" --ciuser "$UTENTE" --cipassword "$PASSWORD" --ciupgrade 1
if [[ -s "$CHIAVE_SSH" ]]; then qm set "$VMID" --sshkeys "$CHIAVE_SSH"; fi

echo "==> Avvio la VM…"
qm start "$VMID"

cat <<FINE

Fatto. La VM $VMID ($NOME) si sta avviando: al primo avvio aggiorna il sistema, ci vogliono 2-3 minuti.

Prossimi passi:
  1. Trova l'indirizzo della VM: nella pagina della VM su Proxmox (Riepilogo) oppure con
       qm guest cmd $VMID network-get-interfaces     (dopo l'installazione)
     o dalla console: qm terminal $VMID   (esci con Ctrl+O)
  2. Entra nella VM:  ssh $UTENTE@<indirizzo>
  3. Copia nella VM la cartella "ponte" del progetto ed esegui:
       sudo DOMINIO=radio.esempio.it bash installa-server.sh   (con il tuo dominio)
FINE
