#!/bin/sh
# The client companies of the SaaS, one isolated cockpit each, on the server
# that runs H-KIDS. Run from /opt/hkids, after H-KIDS' own deployment
# (deploy/docker-compose.yml) is up: its Caddy serves every company's address
# and its image runs every company's cockpit.
#
#   sh scripts/tenant.sh create <slug> --name="Atelier Exemple" --plan=starter \
#        [--domain=exemple.hkids-cockpit.duckdns.org] [--city=Fès] \
#        [--leaders="Sara"] [--activity="..."] [--address="ligne 1|ligne 2"] \
#        [--email=...] [--phone=...] [--legal="ICE ... - RC ..."]
#   sh scripts/tenant.sh user <slug> --id=sara --email=sara@exemple.ma [--name=Sara] [--role=leader]
#   sh scripts/tenant.sh list
#   sh scripts/tenant.sh upgrade            (after a new version of H-KIDS' image)
#   sh scripts/tenant.sh export <slug>      (all of a company's data, in one archive)
#   sh scripts/tenant.sh stop <slug>        (the cockpit stops, its data is kept)
#   sh scripts/tenant.sh start <slug>
#
# Each company's settings are in deploy/tenants/<slug>/.env (readable by this
# account only). The company's own WhatsApp and Meta keys go there too.
set -eu
umask 077

ROOT=$(pwd)
TENANTS="$ROOT/deploy/tenants"
CADDY_SITES="$ROOT/deploy/tenants-caddy"
COMPOSE_FILE="$ROOT/deploy/tenant/docker-compose.yml"
MAIN_ENV="$ROOT/deploy/.env"

fail() {
  echo "Erreur : $*" >&2
  exit 1
}

[ -f "$COMPOSE_FILE" ] || fail "lancer depuis /opt/hkids (deploy/tenant/docker-compose.yml introuvable)."

option() {
  name=$1
  shift
  for argument in "$@"; do
    case "$argument" in
      --"$name"=*) printf '%s' "${argument#--"$name"=}"; return ;;
    esac
  done
}

check_slug() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9-]{1,29}$' || fail "identifiant « $1 » : 2 à 30 caractères, minuscules, chiffres et tirets."
  [ "$1" != "hkids" ] || fail "« hkids » est l'entreprise pilote."
}

# One value of an .env, never shown.
env_value() {
  grep -E "^$2=" "$1" 2>/dev/null | head -n 1 | cut -d= -f2-
}

compose() {
  slug=$1
  shift
  env_file="$TENANTS/$slug/.env"
  [ -f "$env_file" ] || fail "aucune entreprise « $slug »."
  TENANT_ENV_FILE="$env_file" docker compose -p "tenant-$slug" --env-file "$env_file" -f "$COMPOSE_FILE" "$@"
}

reload_caddy() {
  (cd "$ROOT/deploy" && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile)
}

# The company's address, served by H-KIDS' Caddy with the same protections.
write_site() {
  env_file="$TENANTS/$1/.env"
  {
    echo "# $(env_value "$env_file" COMPANY_NAME)"
    echo "$(env_value "$env_file" DOMAIN) {"
    echo "	import cockpit"
    echo "	reverse_proxy $1-app:3000"
    echo "}"
  } > "$CADDY_SITES/$1.caddy"
}

# A value written in an .env on one line, quoted, so a space or a « # » stays.
quoted() {
  printf '"%s"' "$(printf '%s' "$1" | tr -d '"\n\r')"
}

create() {
  slug=$1
  shift
  check_slug "$slug"
  [ ! -e "$TENANTS/$slug" ] || fail "l'entreprise « $slug » existe déjà."
  name=$(option name "$@")
  plan=$(option plan "$@")
  [ -n "$name" ] || fail "--name est obligatoire (nom imprimé sur les documents)."
  case "$plan" in starter|business|enterprise) ;; *) fail "--plan=starter, business ou enterprise." ;; esac
  main_domain=$(env_value "$MAIN_ENV" DOMAIN)
  domain=$(option domain "$@")
  domain=${domain:-$slug.$main_domain}

  mkdir -p "$TENANTS/$slug"
  {
    echo "# Entreprise cliente « $name », créée le $(date +%Y-%m-%d) par scripts/tenant.sh."
    echo "TENANT=$slug"
    echo "DOMAIN=$domain"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "HKIDS_COMPANY_ID=$slug"
    echo "HKIDS_PLAN=$plan"
    echo "COMPANY_NAME=$(quoted "$name")"
    for pair in short-name:COMPANY_SHORT_NAME city:COMPANY_CITY leaders:COMPANY_LEADERS activity:COMPANY_ACTIVITY address:COMPANY_ADDRESS email:COMPANY_EMAIL phone:COMPANY_PHONE legal:COMPANY_LEGAL; do
      value=$(option "${pair%%:*}" "$@")
      [ -z "$value" ] || echo "${pair#*:}=$(quoted "$value")"
    done
    echo "# Le logo imprimé sur les documents (JPEG), à déposer dans le volume de données :"
    echo "# HKIDS_LOGO_PATH=/app/data/logo.jpg"
    echo "# L'IA passe par la clé du service ; le budget mensuel est celui de l'offre."
    for key in OPENAI_API_KEY OPENAI_MODEL OPENAI_REASONING_EFFORT SESSION_DAYS; do
      value=$(env_value "$MAIN_ENV" "$key")
      [ -z "$value" ] || echo "$key=$value"
    done
  } > "$TENANTS/$slug/.env"

  compose "$slug" up -d
  write_site "$slug"
  reload_caddy
  echo "Entreprise « $name » créée : https://$domain (offre $plan)."
  echo "Créez maintenant le compte de sa direction :"
  echo "  sh scripts/tenant.sh user $slug --id=<identifiant> --email=<e-mail> --name=<nom> --role=leader"
}

user() {
  slug=$1
  shift
  check_slug "$slug"
  # The password is typed at the prompt, inside the company's cockpit: it never
  # goes through a command line or a file.
  compose "$slug" exec app node scripts/create-user.mjs "$@"
}

list() {
  for env_file in "$TENANTS"/*/.env; do
    [ -f "$env_file" ] || { echo "Aucune entreprise cliente."; return; }
    slug=$(env_value "$env_file" TENANT)
    state=$(TENANT_ENV_FILE="$env_file" docker compose -p "tenant-$slug" --env-file "$env_file" -f "$COMPOSE_FILE" ps --status running -q app | grep -q . && echo "en marche" || echo "arrêtée")
    echo "$slug — $(env_value "$env_file" COMPANY_NAME) — https://$(env_value "$env_file" DOMAIN) — offre $(env_value "$env_file" HKIDS_PLAN) — $state"
  done
}

# Every running company onto the image just built; a stopped one stays stopped.
upgrade() {
  for env_file in "$TENANTS"/*/.env; do
    [ -f "$env_file" ] || return 0
    slug=$(env_value "$env_file" TENANT)
    if [ -f "$CADDY_SITES/$slug.caddy" ]; then
      compose "$slug" up -d
      echo "$slug : à jour."
    else
      echo "$slug : arrêtée, laissée telle quelle."
    fi
  done
}

start() {
  slug=$1
  check_slug "$slug"
  compose "$slug" up -d
  write_site "$slug"
  reload_caddy
  echo "« $slug » relancée : https://$(env_value "$TENANTS/$slug/.env" DOMAIN)."
}

export_data() {
  slug=$1
  check_slug "$slug"
  stamp=$(date +%Y-%m-%d_%H%M)
  out="$ROOT/deploy/exports/$slug-$stamp"
  mkdir -p "$out"
  compose "$slug" exec -T db pg_dump -U cockpit -d cockpit --format=custom > "$out/base.dump"
  compose "$slug" exec -T app tar -czf - -C /app/assets/documents generated > "$out/documents.tar.gz"
  compose "$slug" exec -T app tar -czf - -C /app data > "$out/data.tar.gz"
  compose "$slug" exec -T app tar -czf - -C /app archive > "$out/archive.tar.gz"
  tar -czf "$out.tar.gz" -C "$ROOT/deploy/exports" "$slug-$stamp"
  rm -rf "$out"
  echo "Export complet : $out.tar.gz ($(du -sh "$out.tar.gz" | cut -f1))."
}

stop() {
  slug=$1
  check_slug "$slug"
  rm -f "$CADDY_SITES/$slug.caddy"
  reload_caddy
  compose "$slug" stop
  echo "« $slug » arrêtée ; ses données sont gardées (relancer : sh scripts/tenant.sh start $slug)."
}

command=${1:-}
[ $# -gt 0 ] && shift
case "$command" in
  create) [ $# -gt 0 ] || fail "identifiant manquant."; create "$@" ;;
  user) [ $# -gt 0 ] || fail "identifiant manquant."; user "$@" ;;
  list) list ;;
  upgrade) upgrade ;;
  export) [ $# -gt 0 ] || fail "identifiant manquant."; export_data "$1" ;;
  stop) [ $# -gt 0 ] || fail "identifiant manquant."; stop "$1" ;;
  start) [ $# -gt 0 ] || fail "identifiant manquant."; start "$1" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
