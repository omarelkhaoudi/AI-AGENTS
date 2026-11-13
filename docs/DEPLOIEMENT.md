# Mettre le cockpit H-KIDS en ligne

Ce guide met le cockpit sur un serveur, accessible depuis Internet en HTTPS, avec
un identifiant et un mot de passe pour chaque personne. Comptez une heure la
première fois.

> **Gratuitement** : un serveur Oracle Cloud « Always Free » convient. Le pas à
> pas complet, de la création du compte à la sauvegarde, est dans
> [DEPLOIEMENT-ORACLE.md](DEPLOIEMENT-ORACLE.md).

## Ce qu'il faut avant de commencer

- **Un serveur Linux** (VPS) avec 2 Go de mémoire au moins et Docker installé.
  Par exemple : Hetzner CX22, OVH VPS Starter, Contabo. Ubuntu 24.04 convient.
- **Un nom de domaine** ou un sous-domaine, par exemple `cockpit.hkids.ma`.
  Dans la zone DNS, créez un enregistrement **A** qui pointe vers l'adresse IP
  du serveur. Attendez qu'il soit actif (quelques minutes à quelques heures)
  avant le premier démarrage : le certificat HTTPS en dépend.
- **La clé OpenAI** (celle du fichier `.env` de ce PC).

## 1. Installer l'application sur le serveur

Connecté au serveur en SSH :

```bash
sudo mkdir -p /opt/hkids && sudo chown $USER /opt/hkids
git clone https://github.com/omarelkhaoudi/AI-AGENTS.git /opt/hkids
cd /opt/hkids/deploy
cp .env.production.example .env
nano .env
```

Dans `deploy/.env`, renseignez :

- `DOMAIN` : le domaine, par exemple `cockpit.hkids.ma` (les liens de suivi
  envoyés aux clients commencent par `https://<DOMAIN>/suivi/`) ;
- `POSTGRES_PASSWORD` : un mot de passe long, généré par `openssl rand -base64 32` ;
- `OPENAI_API_KEY` : la clé OpenAI.

Puis démarrez :

```bash
docker compose up -d --build
docker compose ps
```

Les trois services `db`, `app` et `caddy` doivent être `Up` (`db` en
`healthy`). Si `app` redémarre en boucle, `docker compose logs app` dit
pourquoi. L'adresse `https://<votre domaine>` affiche alors l'écran de
connexion.

## 2. Créer les comptes

Un compte par personne. Le mot de passe est demandé à l'écran : au moins 10
caractères. Il n'apparaît pas pendant la saisie et n'est jamais affiché ensuite.

```bash
docker compose exec app npm run auth:create-user -- --id=hiba --name="Hiba" --email=hiba@exemple.ma --role=leader
docker compose exec app npm run auth:create-user -- --id=omar --name="Omar" --email=omar@exemple.ma --role=leader
docker compose exec app npm run auth:create-user -- --id=hicham --name="Hicham" --email=hicham@exemple.ma --role=operator
```

Rôles possibles :

| Rôle | Ce qu'il peut faire |
| --- | --- |
| `viewer` | consulter, sans parler aux agents ni créer de document |
| `operator` | parler aux agents, préparer et générer des documents |
| `approver` | `operator` + valider les actions sensibles (alertes, publications) |
| `leader` | tout |

Hicham, s'il doit seulement suivre l'activité, peut être `viewer` ; s'il doit
pouvoir parler au Director, il lui faut au moins `operator`.

La même commande, relancée avec le même `--id`, change le mot de passe.

## 3. Reprendre les documents et les données de ce PC

Sans cette étape, la numérotation repart de zéro : le prochain bon de commande
reprendrait un numéro déjà imprimé.

Sur ce PC, copiez vers le serveur le dossier des documents générés et le
dossier `data` :

```bash
scp -r "assets/documents/generated" "data" utilisateur@ip-du-serveur:/opt/hkids/import/
```

Puis sur le serveur :

```bash
cd /opt/hkids/deploy
docker compose cp ../import/generated/. app:/app/assets/documents/generated/
docker compose cp ../import/data/. app:/app/data/
docker compose exec -u root app chown -R node:node /app/assets/documents/generated /app/data
rm -rf ../import
```

Si le catalogue Excel se trouve ailleurs que dans `data/` sur ce PC, copiez-le
dans `data/catalogue-hkids.xlsx`.

Pour vérifier, demandez au Director : « quel est le prochain numéro de bon de
commande ? » Il doit donner le même numéro que sur ce PC.

## 4. Sauvegardes

Le script `scripts/backup.sh` sauvegarde la base, les documents, les données et
les dossiers clients dans `deploy/backups/<date>/` et garde les 30 dernières. Pour le lancer chaque
nuit à 3 h :

```bash
crontab -e
```

et ajoutez la ligne :

```
0 3 * * * cd /opt/hkids/deploy && mkdir -p backups && sh ../scripts/backup.sh >> backups/backup.log 2>&1
```

Une sauvegarde sur le même disque ne protège pas d'une panne du serveur :
copiez régulièrement `deploy/backups/` ailleurs, par exemple avec `scp`
vers un ordinateur du bureau.

**Restaurer** la base depuis une sauvegarde :

```bash
docker compose exec -T db pg_restore -U hkids -d hkids --clean --if-exists --no-owner < backups/<date>/base.dump
```

Les documents, les données et les dossiers clients se restaurent de la même
façon, voir [DEPLOIEMENT-ORACLE.md](DEPLOIEMENT-ORACLE.md), section 8.

## 5. Mettre à jour l'application

```bash
cd /opt/hkids && git pull
cd deploy && docker compose up -d --build
```

Les migrations de la base s'appliquent au démarrage. Les documents, les données
et les conversations sont dans des volumes Docker : une mise à jour ne les
touche pas.

## Sécurité, ce qui est en place

- HTTPS obligatoire, certificat renouvelé automatiquement par Caddy.
- Connexion par email et mot de passe ; seul un hachage scrypt est stocké.
  Une session dure 30 jours sur un appareil (`SESSION_DAYS`), et le bouton
  « Déconnexion » la révoque.
- 5 essais de connexion par minute et par adresse, puis refus.
- Le mode démo (connexion automatique) est refusé par le serveur en production.
- Seul Caddy est ouvert sur Internet ; l'application et la base ne le sont pas.
- La clé OpenAI et le mot de passe de la base sont uniquement dans
  `deploy/.env`, sur le serveur, jamais dans Git.
