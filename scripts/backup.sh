#!/bin/sh
# Backs up the hosted cockpit: the database, the documents issued (with their
# numbering) and the company data (catalogue, plans, conversations, workshop
# book). Run it on
# the server, from the deploy/ folder, every night from cron:
#
#   0 3 * * * cd /opt/hkids/deploy && sh ../scripts/backup.sh >> backups/backup.log 2>&1
#
# Each run writes one dated folder under deploy/backups/ and keeps the last 30.
# Copy that folder off the server as well (to a computer or cloud storage): a
# backup on the same disk does not survive the loss of the disk.
set -eu

stamp=$(date +%Y-%m-%d_%H%M)
target="backups/$stamp"
mkdir -p "$target"

docker compose exec -T db pg_dump -U hkids -d hkids --format=custom > "$target/base.dump"
docker compose exec -T app tar -czf - -C /app/assets/documents generated > "$target/documents.tar.gz"
docker compose exec -T app tar -czf - -C /app data > "$target/data.tar.gz"

# Oldest first; everything past the 30 most recent is removed.
ls -1d backups/20* | head -n -30 | xargs -r rm -rf

echo "$stamp sauvegarde faite : $(du -sh "$target" | cut -f1)"
