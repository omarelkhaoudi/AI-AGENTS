#!/bin/sh
# Prepares a free Oracle Cloud server (Ubuntu 22.04 or 24.04, Ampere or AMD) for
# the H-KIDS cockpit, in one command, from the server's SSH session:
#
#   curl -fsSL https://raw.githubusercontent.com/omarelkhaoudi/AI-AGENTS/main/scripts/oracle-setup.sh | sh
#
# It installs Docker, opens ports 80 and 443 in the server's own firewall
# (Oracle's Ubuntu images block them, on top of the cloud's security list),
# fetches the application into /opt/hkids and writes deploy/.env with a
# generated database password. Nothing starts yet: DOMAIN and the OpenAI key are
# still to fill in (docs/DEPLOIEMENT-ORACLE.md, step 5). Run again, it changes
# nothing that is already done and never overwrites deploy/.env.
set -eu

say() { printf '\n==> %s\n' "$1"; }

say "Mise à jour du système"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl openssl iptables-persistent

if ! command -v docker >/dev/null 2>&1; then
  say "Installation de Docker"
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"

say "Ouverture des ports 80 et 443 (pare-feu du serveur)"
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    # Before Oracle's final REJECT rule, or the opening has no effect.
    reject=$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
    if [ -n "$reject" ]; then
      sudo iptables -I INPUT "$reject" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    else
      sudo iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  fi
done
sudo netfilter-persistent save

say "Récupération du cockpit H-KIDS dans /opt/hkids"
if [ ! -d /opt/hkids/.git ]; then
  sudo mkdir -p /opt/hkids
  sudo chown "$USER":"$USER" /opt/hkids
  git clone https://github.com/omarelkhaoudi/AI-AGENTS.git /opt/hkids
else
  git -C /opt/hkids pull --ff-only
fi

cd /opt/hkids/deploy
if [ ! -f .env ]; then
  say "Création de deploy/.env (mot de passe de la base généré)"
  cp .env.production.example .env
  password=$(openssl rand -hex 24)
  sed -i "s|^POSTGRES_PASSWORD=\"\"|POSTGRES_PASSWORD=\"$password\"|" .env
  chmod 600 .env
fi

cat <<'EOF'

==> Serveur prêt.

Il reste, dans l'ordre (docs/DEPLOIEMENT-ORACLE.md, étape 5) :
  1. Déconnectez-vous (exit) puis reconnectez-vous en SSH, pour que Docker
     vous reconnaisse.
  2. nano /opt/hkids/deploy/.env
       DOMAIN="votre-adresse.duckdns.org"
       OPENAI_API_KEY="la clé OpenAI"
  3. cd /opt/hkids/deploy && docker compose up -d --build
EOF
