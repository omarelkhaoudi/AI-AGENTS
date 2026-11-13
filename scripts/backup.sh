#!/bin/sh
# Backs up the hosted cockpit: the database, the documents issued (with their
# numbering), the company data (catalogue, plans, conversations, workshop book)
# and the client folders of the Administratif. Run it on the server, from the
# deploy/ folder, every night from cron:
#
#   0 3 * * * cd /opt/hkids/deploy && mkdir -p backups && sh ../scripts/backup.sh >> backups/backup.log 2>&1
#
# Each run writes one dated folder under deploy/backups/ and keeps the last 30.
# Copy that folder off the server as well (to a computer or cloud storage): a
# backup on the same disk does not survive the loss of the disk.
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

mv "$partial" "backups/$stamp"

# Oldest first; everything past the 30 most recent is removed.
ls -1d backups/20* | head -n -30 | xargs -r rm -rf

echo "$stamp sauvegarde faite : $(du -sh "backups/$stamp" | cut -f1)"
