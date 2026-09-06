# Guide d'installation — V1 MVP

> ⚠️ **Instantané historique.** Ce guide décrit la V1 telle qu'elle était au
> commit `c2c1d89`. Il est conservé comme trace de cette livraison et ses
> chiffres sont ceux d'alors.
>
> **Pour installer le projet aujourd'hui, suivez le
> [README](../README.md).** Les variables d'environnement sont détaillées dans
> [`ENVIRONMENT.md`](ENVIRONMENT.md). Plusieurs points ont changé depuis :
> le nombre d'outils, le nombre de migrations, le comportement d'une
> `DATABASE_URL` invalide, les polices des documents H-KIDS et le chargement de
> `.env` par `auth:create-token`.

**Commit de référence : `c2c1d89`**

Ce guide mène d'un poste vierge à une application démarrée et testée. Deux
chemins sont possibles : **sans base de données** (le plus rapide, suffisant
pour une démonstration) ou **avec PostgreSQL** (persistance réelle).

---

## 1. Prérequis

| Élément | Version | Obligatoire |
| --- | --- | --- |
| Node.js | **20 ou supérieur** | oui |
| npm | fourni avec Node.js | oui |
| PostgreSQL | 14 ou supérieur | non — voir §5 |
| Compte n8n | — | non — voir §8 |
| Clé OpenAI | — | non — voir §4 |

Vérifier Node.js :

```bash
node --version
```

---

## 2. Installation

```bash
git clone https://github.com/omarelkhaoudi/AI-AGENTS.git
```

```bash
cd AI-AGENTS
```

```bash
npm install
```

---

## 3. Configuration

La configuration passe **entièrement par des variables d'environnement**.

Le fichier `.env.example` est la référence versionnée. **Il ne contient aucune
valeur réelle.** Copiez-le :

```bash
cp .env.example .env
```

> ### ⚠️ Aucun secret réel ne doit jamais être committé
>
> `.env` est ignoré par Git et doit le rester. **Aucune valeur réelle** — mot de
> passe de base, clé OpenAI, jeton n8n — ne doit être écrite dans `.env.example`,
> dans le code, dans la documentation, ni dans un message de commit.
>
> Le dépôt embarque un contrôle automatique :
>
> ```bash
> npm run scan:secrets
> ```
>
> Lancez-le avant tout commit. Si un secret a été committé par erreur, il doit
> être **révoqué et remplacé**, pas seulement supprimé de l'historique.

### Variables principales

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `DATABASE_URL` | Connexion PostgreSQL | vide → dépôt mémoire |
| `BUSINESS_MEMORY_PROVIDER` | `memory` ou `postgres` | `memory` |
| `PLANNER_PROVIDER` | `deterministic`, `stub_llm`, `llm_mock`, `llm_openai` | `deterministic` |
| `AUTH_MODE` | `token` ou `demo` | `token` |
| `PORT` / `HOST` | Écoute du serveur | `3000` / `127.0.0.1` |
| `RUN_POSTGRES_INTEGRATION` | Active les tests d'intégration base | `false` |

`AUTH_MODE="demo"` expose une route qui distribue un jeton de démonstration.
Elle est **refusée si `NODE_ENV=production`**. Pratique pour une démonstration,
à ne jamais utiliser en production.

---

## 4. OpenAI — facultatif

La V1 fonctionne **entièrement hors ligne** avec le planificateur par défaut.

Pour activer un vrai modèle :

```
PLANNER_PROVIDER="llm_openai"
OPENAI_API_KEY="<votre cle>"
```

Sans cette variable, aucun appel réseau n'est effectué vers OpenAI. Détails dans
[`PLANNER_CONFIGURATION.md`](PLANNER_CONFIGURATION.md).

---

## 5. PostgreSQL — facultatif

**Sans `DATABASE_URL`, l'application démarre et fonctionne**, avec un dépôt en
mémoire. Les données disparaissent à l'arrêt du processus.

Pour une persistance réelle :

```
DATABASE_URL="postgresql://<utilisateur>:<mot_de_passe>@localhost:5432/ai_agents?schema=public"
BUSINESS_MEMORY_PROVIDER="postgres"
```

Puis, dans l'ordre :

```bash
npm run db:generate
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run db:seed:business
```

`db:seed` crée les dix agents et leurs permissions. `db:seed:business` charge les
données métier de démonstration. Les deux sont **idempotents** : les relancer ne
crée pas de doublons.

> **Prisma 7 ne lit plus `.env` automatiquement.** Exportez `DATABASE_URL` dans
> l'environnement du shell avant de lancer `db:generate` et `db:migrate`, sinon
> ces commandes échouent en indiquant qu'elles ne résolvent pas la variable.

Installation complète de la base — Docker ou local — dans
[`POSTGRESQL_SETUP.md`](POSTGRESQL_SETUP.md).

---

## 6. Démarrage

```bash
npm start
```

L'API écoute sur `http://127.0.0.1:3000`.

Vérification immédiate :

```bash
curl http://127.0.0.1:3000/health
```

Réponse attendue : `{"status":"ok","service":"ai-agents", ...}`

---

## 7. Accès au cockpit et à l'API

### Cockpit

Ouvrir **http://127.0.0.1:3000/** dans un navigateur.

### Obtenir un jeton

**Option A — mode démonstration.** Avec `AUTH_MODE="demo"` dans `.env` :

```bash
curl http://127.0.0.1:3000/api/auth/demo-session
```

Renvoie un jeton et un utilisateur de rôle `leader`.

**Option B — mode jeton (recommandé).** Nécessite `DATABASE_URL`, sinon le jeton
créé dans un autre processus serait perdu :

```bash
npm run auth:create-token -- --user-id=hiba --role=leader
```

Le secret est **affiché une seule fois** et n'est jamais stocké en clair.

### Routes principales

| Méthode | Route | Capacité requise |
| --- | --- | --- |
| `GET` | `/health` | aucune |
| `POST` | `/api/director/requests` | `create_requests` |
| `POST` | `/api/requests` | `create_requests` |
| `GET` | `/api/requests/:id` | `read_requests` |
| `GET` | `/api/approvals` | `read_requests` |
| `POST` | `/api/approvals/:id/approve` | `decide_approvals` |
| `POST` | `/api/approvals/:id/reject` | `decide_approvals` |
| `POST` | `/api/production/delay-alerts` | `create_requests` |

Toutes les routes `/api` exigent un en-tête `Authorization: Bearer <jeton>`.

---

## 8. Configuration n8n — facultatif

**Le pont n8n est désactivé par défaut et l'application n'en a pas besoin pour
fonctionner.**

Pour l'activer, renseignez dans `.env` :

```
WORKFLOW_PROVIDER="n8n"
WORKFLOW_ENABLED="true"
WORKFLOW_BASE_URL="<origine + prefixe du webhook n8n>"
N8N_WEBHOOK_PATH="<chemin du webhook>"
N8N_API_KEY_HEADER="X-AI-Agents-Token"
N8N_API_KEY="<votre jeton>"
```

L'URL appelée est la **concaténation** de `WORKFLOW_BASE_URL` et
`N8N_WEBHOOK_PATH`. Si l'URL de production n8n est
`https://<sous-domaine>.app.n8n.cloud/webhook/delay-alert`, coupez-la où vous
voulez entre les deux variables.

### Ce que le workflow n8n doit respecter

| Exigence | Détail |
| --- | --- |
| Méthode | `POST` |
| Authentification | Header Auth, en-tête `X-AI-Agents-Token` |
| Réponse | statut 2xx **et corps JSON valide** |
| Délai | moins de **5 secondes** (`N8N_TIMEOUT_MS`) |
| URL | l'URL de **production**, workflow **publié** |

Un corps vide ou non JSON provoque une erreur `N8N_INVALID_RESPONSE`.

### Garde-fous

- Si `WORKFLOW_ENABLED` n'est pas `"true"`, aucun client n'est construit et
  l'outil n'est pas enregistré. `POST /api/production/delay-alerts` répond `409`
  avec le code `WORKFLOW_NOT_ENABLED`.
- Si `WORKFLOW_ENABLED="true"` mais qu'une variable n8n manque, **l'application
  refuse de démarrer** plutôt que de tourner à moitié configurée.
- Le jeton n8n reste dans `process.env` et dans une fermeture ; il n'entre jamais
  dans l'objet de configuration ni dans un message d'erreur.

---

## 9. Lancement des tests

> ⚠️ **Les compteurs de cette section sont ceux du commit `c2c1d89`.** Ils ne
> correspondent plus à la suite actuelle, qui compte davantage de tests. Pour
> les chiffres mesurés aujourd'hui, voir le [README](../README.md), section
> « Tests et validation ». Les commandes, elles, restent valides.

### Suite complète, sans base

```bash
npm test
```

Attendu **au commit `c2c1d89`** : 723 tests, 693 réussis, 0 échec, 30 ignorés.
Les tests ignorés sont les tests d'intégration PostgreSQL.

### Suite complète, avec PostgreSQL

Exportez `DATABASE_URL` et `RUN_POSTGRES_INTEGRATION="true"`, puis :

```bash
npm test
```

Attendu **au commit `c2c1d89`** : 723 tests, 723 réussis, 0 échec, 0 ignoré.

### Autres contrôles

```bash
npm run lint
```

```bash
npm run build
```

```bash
npm run scan:secrets
```

---

## 10. Problèmes courants

| Symptôme | Cause probable |
| --- | --- |
| `Cannot resolve environment variable: DATABASE_URL` | Prisma ne lit pas `.env` : exportez la variable dans le shell |
| 30 tests ignorés | `RUN_POSTGRES_INTEGRATION` absent ou `DATABASE_URL` vide — comportement normal |
| `401` sur `/api/...` | En-tête `Authorization: Bearer` absent ou jeton révoqué |
| `403` sur une approbation | Le rôle ne porte pas la capacité `decide_approvals` |
| `409 WORKFLOW_NOT_ENABLED` | Pont n8n désactivé, ou serveur non redémarré après édition de `.env` |
| L'application refuse de démarrer | `WORKFLOW_ENABLED="true"` avec une variable n8n manquante |
