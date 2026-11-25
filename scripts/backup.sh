#!/bin/sh
# Backs up the hosted cockpit: the database, the documents issued (with their
# numbering), the company data (catalogue, plans, conversations, workshop book)
# and the client folders of the Administratif. Run it on the server, from the
# deploy/ folder, every night from cron:
#
#   0 3 * * * cd /opt/hkids/deploy && mkdir -p backups && sh ../scripts/backup.sh >> backups/backup.log 2>&1
#
# Each run writes one dated folder under deploy/backups/ and keeps the last 30.
#
# A backup on the same disk does not survive the loss of the server: with
# deploy/backup-offsite.env (see scripts/backup-offsite.env.example), each
# backup is also encrypted (AES-256, the passphrase stays on the server and with
# the direction) and sent to a bucket of Oracle Object Storage, outside the
# machine. scripts/restore-test.sh proves, each month, that it restores.
set -eu

# The backups hold client data: readable by this account only.
umask 077

stamp=$(date +%Y-%m-%d_%H%M)

# A run writes into a hidden folder and only renames it once every part is
# there, so a failed run never leaves a half backup that looks complete. The
# next run clears what a failed one left.
rm -rf backups/.20*
partial="backups/.$stamp"
mkdir -p "$partial"

docker compose exec -T db pg_dump -U hkids -d hkids --format=custom > "$partial/base.dump"
docker compose exec -T app tar -czf - -C /app/assets/documents generated > "$partial/documents.tar.gz"
docker compose exec -T app tar -czf - -C /app data > "$partial/data.tar.gz"
docker compose exec -T app tar -czf - -C /app archive > "$partial/archive.tar.gz"

# The client companies of the SaaS (scripts/tenant.sh), each in its own folder.
# A stopped one has nothing new to save: its last backup stays.
for env_file in tenants/*/.env; do
  [ -f "$env_file" ] || continue
  slug=$(grep -E '^TENANT=' "$env_file" | cut -d= -f2-)
  tenant() {
    TENANT_ENV_FILE="$PWD/$env_file" docker compose -p "tenant-$slug" --env-file "$env_file" -f tenant/docker-compose.yml "$@"
  }
  if ! tenant ps --status running -q cockpit | grep -q .; then
    continue
  fi
  mkdir -p "$partial/tenants/$slug"
  tenant exec -T company-db pg_dump -U cockpit -d cockpit --format=custom > "$partial/tenants/$slug/base.dump"
  tenant exec -T cockpit tar -czf - -C /app/assets/documents generated > "$partial/tenants/$slug/documents.tar.gz"
  tenant exec -T cockpit tar -czf - -C /app data > "$partial/tenants/$slug/data.tar.gz"
  tenant exec -T cockpit tar -czf - -C /app archive > "$partial/tenants/$slug/archive.tar.gz"
done

mv "$partial" "backups/$stamp"

# The copy outside the server. A failed upload is said in the log and does not
# undo the local backup; the next night sends its own.
if [ -f backup-offsite.env ]; then
  . ./backup-offsite.env
  if sh ../scripts/backup-offsite.sh send "backups/$stamp"; then
    echo "$stamp copie hors serveur envoyée"
  else
    echo "$stamp ÉCHEC de la copie hors serveur"
  fi
fi

# Oldest first; everything past the 30 most recent is removed.
ls -1d backups/20* | head -n -30 | xargs -r rm -rf

echo "$stamp sauvegarde faite : $(du -sh "backups/$stamp" | cut -f1)"
