# Mettre le cockpit H-KIDS en ligne gratuitement (Oracle Cloud)

Le cockpit sur un serveur Oracle **gratuit à vie** (« Always Free »), allumé
24 h/24, en HTTPS, avec un identifiant et un mot de passe par personne. Hiba,
Omar et l'équipe l'ouvrent depuis n'importe quel ordinateur ou téléphone.

Comptez **1 h 30** la première fois. Seule la clé OpenAI reste payante.

## Ce qu'il faut avant de commencer

- Une **carte bancaire** : Oracle la demande pour vérifier l'identité (un petit
  montant peut être bloqué puis rendu ; rien n'est facturé tant qu'on reste
  dans l'offre gratuite).
- Une adresse email et un téléphone.
- La **clé OpenAI** (celle du fichier `.env` du PC).
- Ce PC Windows, avec PowerShell (ssh et scp y sont déjà).

## 1. Créer le compte Oracle Cloud

1. Allez sur <https://www.oracle.com/cloud/free/> → **Start for free**.
2. Remplissez le formulaire. **Région d'origine** (« Home Region ») : prenez la
   plus proche, par exemple **Spain Central (Madrid)** ou **France South
   (Marseille)**. Elle ne peut plus être changée ensuite.
3. Validez l'email, le téléphone et la carte. L'ouverture du compte peut
   prendre de quelques minutes à quelques heures.

## 2. Créer le serveur

Dans la console Oracle : menu ☰ → **Compute** → **Instances** → **Create instance**.

| Réglage | Valeur |
| --- | --- |
| Name | `hkids-cockpit` |
| Image | **Canonical Ubuntu 24.04** (bouton « Change image ») |
| Shape | **Ampere** → `VM.Standard.A1.Flex`, **2 OCPU**, **12 Go** de mémoire (gratuit jusqu'à 4 OCPU / 24 Go) |
| Networking | « Create new virtual cloud network », sous-réseau **public**, **Assign a public IPv4 address** coché |
| Add SSH keys | **Generate a key pair for me** → **Save private key** |
| Boot volume | laisser 50 Go (gratuit jusqu'à 200 Go) |

Rangez la clé privée téléchargée dans `C:\Users\<vous>\.ssh\hkids-oracle.key`.
**Ne la perdez pas** : c'est la seule façon d'entrer sur le serveur.

Cliquez **Create**. Quand l'instance est **Running**, notez son **Public IP
address** (par exemple `152.67.xx.xx`).

> « Out of capacity for shape VM.Standard.A1.Flex » : les serveurs Ampere
> gratuits sont parfois tous pris. Réessayez plus tard, ou changez de
> « Availability domain » dans le formulaire.

## 3. Ouvrir les ports du site (80 et 443)

Sur la page de l'instance : **Primary VNIC** → le lien du **Subnet** →
**Security Lists** → **Default Security List** → **Add Ingress Rules**. Ajoutez
deux règles :

| Source CIDR | IP Protocol | Destination Port Range |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(Le port 22, pour SSH, est déjà ouvert.)

## 4. Une adresse gratuite pour le cockpit (DuckDNS)

Le certificat HTTPS demande un nom, pas seulement une adresse IP.

1. Allez sur <https://www.duckdns.org>, connectez-vous (Google ou GitHub).
2. Créez un sous-domaine, par exemple `hkids-cockpit` →
   `hkids-cockpit.duckdns.org`.
3. Dans **current ip**, mettez l'adresse IP publique du serveur → **update ip**.

Si H-KIDS a déjà un nom de domaine (par exemple `hkids.ma`), créez plutôt un
enregistrement **A** `cockpit.hkids.ma` → l'IP du serveur, chez le registraire.

## 5. Installer le cockpit sur le serveur

Dans PowerShell, sur ce PC (remplacez l'IP) :

```powershell
icacls "$env:USERPROFILE\.ssh\hkids-oracle.key" /inheritance:r /grant:r "$($env:USERNAME):R"
ssh -i "$env:USERPROFILE\.ssh\hkids-oracle.key" ubuntu@152.67.xx.xx
```

(La première commande protège la clé : sans elle, ssh la refuse. À la
question « Are you sure you want to continue connecting », tapez `yes`.)

Une fois connecté au serveur, une seule commande installe tout (Docker, le
pare-feu, le cockpit) :

```bash
curl -fsSL https://raw.githubusercontent.com/omarelkhaoudi/AI-AGENTS/main/scripts/oracle-setup.sh | sh
```

Puis, comme elle le demande à la fin :

```bash
exit
```

Reconnectez-vous (même commande `ssh` qu'avant), et renseignez l'adresse et la
clé OpenAI :

```bash
nano /opt/hkids/deploy/.env
```

- `DOMAIN="hkids-cockpit.duckdns.org"` (votre adresse, sans `https://`) ;
- `OPENAI_API_KEY="..."` (la clé OpenAI).

Le mot de passe de la base est déjà rempli. Enregistrez : **Ctrl+O**, Entrée,
puis **Ctrl+X**. Démarrez :

```bash
cd /opt/hkids/deploy
docker compose up -d --build
docker compose ps
```

La première fois, la construction prend 5 à 10 minutes. Les trois services
`db`, `app` et `caddy` doivent être `Up`. Ouvrez
`https://hkids-cockpit.duckdns.org` : l'écran de connexion s'affiche.

## 6. Créer les comptes

Un compte par personne ; le mot de passe est demandé à l'écran (10 caractères
au moins) :

```bash
docker compose exec app npm run auth:create-user -- --id=hiba --name="Hiba" --email=hiba@exemple.ma --role=leader
docker compose exec app npm run auth:create-user -- --id=omar --name="Omar" --email=omar@exemple.ma --role=leader
```

Les rôles et la suite : [DEPLOIEMENT.md, section 2](DEPLOIEMENT.md#2-créer-les-comptes).

## 7. Reprendre les données du PC de Hiba

Sans cette étape, la numérotation des devis et des bons repartirait de zéro.
Sur le PC qui a les vraies données, dans PowerShell, dans le dossier du projet :

```powershell
ssh -i "$env:USERPROFILE\.ssh\hkids-oracle.key" ubuntu@152.67.xx.xx "mkdir -p /opt/hkids/import"
scp -i "$env:USERPROFILE\.ssh\hkids-oracle.key" -r "assets/documents/generated" "data" ubuntu@152.67.xx.xx:/opt/hkids/import/
```

Puis sur le serveur :

```bash
cd /opt/hkids/deploy
docker compose cp ../import/generated/. app:/app/assets/documents/generated/
docker compose cp ../import/data/. app:/app/data/
docker compose exec -u root app chown -R node:node /app/assets/documents/generated /app/data
docker compose restart app
rm -rf ../import
```

Vérifiez en demandant au Director : « quel est le prochain numéro de bon de
commande ? » : le même que sur le PC.

## 8. Sauvegardes automatiques

Chaque nuit à 3 h (heure du serveur, UTC), la base, les documents, les données
et les dossiers clients, dans `deploy/backups/<date>/`. Les 30 dernières sont
gardées :

```bash
crontab -e
```

Ajoutez la ligne :

```
0 3 * * * cd /opt/hkids/deploy && mkdir -p backups && sh ../scripts/backup.sh >> backups/backup.log 2>&1
```

Une fois par semaine, rapatriez les sauvegardes sur un PC (une sauvegarde sur
le même serveur ne protège pas d'une panne du serveur) :

```powershell
scp -i "$env:USERPROFILE\.ssh\hkids-oracle.key" -r ubuntu@152.67.xx.xx:/opt/hkids/deploy/backups "$env:USERPROFILE\Documents\Sauvegardes H-KIDS"
```

**Restaurer** une sauvegarde, sur le serveur, depuis `/opt/hkids/deploy` (cela
remplace les données actuelles : faites d'abord une sauvegarde de l'état
présent avec `sh ../scripts/backup.sh`) :

```bash
b=backups/2026-11-13_0300   # le dossier à restaurer
docker compose exec -T db pg_restore -U hkids -d hkids --clean --if-exists --no-owner < $b/base.dump
docker compose exec -T app tar -xzf - -C /app/assets/documents < $b/documents.tar.gz
docker compose exec -T app tar -xzf - -C /app < $b/data.tar.gz
docker compose exec -T app tar -xzf - -C /app < $b/archive.tar.gz
docker compose restart app
```

## 9. Mettre à jour

Après chaque nouveauté poussée sur GitHub :

```bash
cd /opt/hkids && git pull
cd deploy && docker compose up -d --build
```

Les données, les documents et les dossiers clients sont dans des volumes
Docker : une mise à jour ne les touche pas.

## Ce qui change pour Hiba

- Elle ouvre le cockpit à son adresse (`https://…duckdns.org`) avec son email
  et son mot de passe, depuis son PC ou son téléphone (sur le téléphone :
  « Ajouter à l'écran d'accueil »). Le raccourci « H-KIDS Cockpit » du Bureau
  n'est plus nécessaire.
- Les dossiers clients ne sont plus sur son Bureau mais sur le serveur. Elle
  retrouve chaque document dans **Documents → Registre des documents** (bouton
  « Ouvrir le PDF ») ou en le demandant au Director, et « Exporter en Excel »
  télécharge le registre.

## À savoir

- **Serveur inactif repris par Oracle.** Oracle peut récupérer un serveur
  gratuit qui ne travaille presque pas pendant 7 jours. Pour l'éviter, passez
  le compte en **Pay As You Go** (menu ☰ → Billing → Upgrade) : on reste
  gratuit tant qu'on ne dépasse pas les limites « Always Free », et le serveur
  n'est plus repris. Mettez aussi une **alerte de budget** à 1 € (Billing →
  Budgets) pour être prévenu au moindre centime.
- **Données personnelles (loi 09-08).** Les données des clients sont alors
  hébergées hors du Maroc. Vérifiez auprès de la CNDP la déclaration à faire
  pour ce transfert avant d'y mettre les vraies données.
- **Sécurité.** HTTPS, mots de passe, limite des essais de connexion : voir
  [DEPLOIEMENT.md, « Sécurité »](DEPLOIEMENT.md#sécurité-ce-qui-est-en-place).
  La clé `hkids-oracle.key` donne accès au serveur : gardez-la pour vous.
- **WhatsApp.** Une fois le cockpit en ligne, le numéro WhatsApp Business peut
  être branché : ses clés `WHATSAPP_*` vont dans `deploy/.env`.
