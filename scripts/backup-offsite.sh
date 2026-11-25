#!/bin/sh
# The backup's copy outside the server, in a bucket of Oracle Object Storage
# reached by a pre-authenticated request (an address that allows reading and
# writing objects in that bucket only, made once in the Oracle console).
#
#   sh ../scripts/backup-offsite.sh send backups/2026-11-25_0300
#   sh ../scripts/backup-offsite.sh fetch 2026-11-25_0300 /tmp/restore
#
# Read from deploy/backup-offsite.env:
#   BACKUP_OFFSITE_URL      the request's address, ending with /o/
#   BACKUP_PASSPHRASE_FILE  a file holding the passphrase (readable by this
#                           account only); without it, nothing is sent.
#
# The folder is encrypted before it leaves (AES-256, key derived with PBKDF2):
# the bucket only ever holds ciphertext.
set -eu
umask 077

: "${BACKUP_OFFSITE_URL:?BACKUP_OFFSITE_URL manque dans backup-offsite.env}"
: "${BACKUP_PASSPHRASE_FILE:?BACKUP_PASSPHRASE_FILE manque dans backup-offsite.env}"
[ -s "$BACKUP_PASSPHRASE_FILE" ] || { echo "Phrase de chiffrement introuvable : $BACKUP_PASSPHRASE_FILE" >&2; exit 1; }

object() {
  echo "hkids-$1.tar.enc"
}

case "${1:-}" in
  send)
    folder=${2:?dossier de sauvegarde attendu}
    stamp=$(basename "$folder")
    encrypted=$(mktemp)
    trap 'rm -f "$encrypted"' EXIT
    tar -cf - -C "$(dirname "$folder")" "$stamp" \
      | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$encrypted"
    curl --fail --silent --show-error --retry 3 -X PUT --upload-file "$encrypted" "${BACKUP_OFFSITE_URL}$(object "$stamp")"
    ;;
  fetch)
    stamp=${2:?date de sauvegarde attendue}
    target=${3:?dossier de destination attendu}
    mkdir -p "$target"
    curl --fail --silent --show-error --retry 3 "${BACKUP_OFFSITE_URL}$(object "$stamp")" \
      | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" \
      | tar -xf - -C "$target"
    ;;
  *)
    echo "Usage : backup-offsite.sh send <dossier> | fetch <date> <destination>" >&2
    exit 2
    ;;
esac
