#!/bin/sh
# Proves that the last backup restores, as the CDC asks (section 14): a backup
# that was never restored is a hope. Run on the server, from deploy/, by hand
# or each month from cron:
#
#   0 4 1 * * cd /opt/hkids/deploy && sh ../scripts/restore-test.sh >> backups/restore-test.log 2>&1
#
# It takes the most recent backup: the copy outside the server when one is set
# (downloaded and decrypted: the whole way back), the local one otherwise. Its
# database is restored into a temporary database beside the live one, each
# table counted on both sides, and its archives read through. Nothing of the
# live cockpit is touched; the temporary database is dropped at the end.
#
# The counts may differ for tables written since the backup was made (one
# night at most): that is normal. A table missing from the backup, or empty in
# it while the live one is not, is an error.
set -eu
umask 077

latest=$(ls -1d backups/20* 2>/dev/null | tail -n 1)
[ -n "$latest" ] || { echo "$(date +%F) ÉCHEC : aucune sauvegarde dans backups/"; exit 1; }
stamp=$(basename "$latest")
work=$(mktemp -d)
test_db="hkids_restore_test"
cleanup() {
  docker compose exec -T db dropdb -U hkids --if-exists "$test_db" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

source="locale"
folder="$latest"
if [ -f backup-offsite.env ]; then
  . ./backup-offsite.env
  sh ../scripts/backup-offsite.sh fetch "$stamp" "$work"
  folder="$work/$stamp"
  source="hors serveur (téléchargée et déchiffrée)"
fi

for archive in documents data archive; do
  tar -tzf "$folder/$archive.tar.gz" >/dev/null
done

docker compose exec -T db dropdb -U hkids --if-exists "$test_db"
docker compose exec -T db createdb -U hkids "$test_db"
docker compose exec -T db pg_restore -U hkids -d "$test_db" --no-owner --exit-on-error < "$folder/base.dump"

count() {
  docker compose exec -T db psql -U hkids -d "$1" -Atc "select count(*) from public.\"$2\""
}
tables=$(docker compose exec -T db psql -U hkids -d hkids -Atc "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1")
problems=""
checked=0
for table in $tables; do
  live=$(count hkids "$table")
  restored=$(count "$test_db" "$table" 2>/dev/null || echo "absente")
  checked=$((checked + 1))
  if [ "$restored" = "absente" ] || { [ "$restored" -lt "$live" ] 2>/dev/null && [ "$restored" -eq 0 ]; }; then
    problems="$problems $table($restored/$live)"
  fi
done

if [ -n "$problems" ]; then
  echo "$(date +%F) ÉCHEC : sauvegarde $stamp ($source), tables manquantes ou vides :$problems"
  exit 1
fi
echo "$(date +%F) restauration réussie : sauvegarde $stamp ($source), $checked tables comparées, archives lisibles."
