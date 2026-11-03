# Variables d'environnement

Référence complète des variables lues par `AI AGENTS`. Chaque variable listée
ici est **réellement lue par le code** ou par `docker-compose.yml` ; aucune
n'est décorative.

`.env.example` est la référence versionnée. **Il ne contient aucune valeur
réelle**, et ne doit jamais en contenir. `.env` est ignoré par Git.

---

## Comment `.env` est chargé

Le projet n'a **aucune dépendance `dotenv`**. Le chargement est fait par
`src/load-dotenv.js`, appelé au démarrage par :

| Point d'entrée | Charge `.env` |
| --- | --- |
| `npm start` | oui |
| `npm run db:seed` | oui |
| `npm run db:seed:business` | oui |
| `npm run auth:create-token` | oui |
| `npm run data:ingest` | oui |
| `npm test` | **non** — `node --test` ne charge rien |
| `npm run db:generate` / `db:migrate` | **non** — c'est Prisma qui lit `prisma.config.js` |

Trois règles à retenir :

1. **Une variable déjà présente dans l'environnement du shell gagne toujours**
   sur le fichier. C'est délibéré : un `export` est un choix explicite.
2. Le fichier est lu **une seule fois, au démarrage**. Après modification,
   redémarrez.
3. Il est cherché à `.env` **relatif au répertoire courant**. Lancez les
   commandes depuis la racine du dépôt.

**Rien n'est obligatoire pour démarrer l'API.** Pour une démo navigateur, renseignez `AUTH_MODE="demo"` afin que le cockpit obtienne automatiquement un jeton. L'application démarre aussi sur un `.env` intégralement copié depuis `.env.example`, mais le cockpit demandera alors une authentification en mode `token`.

---

## Application

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | non | Environnement déclaré. La seule valeur qui change un comportement est `production`, qui **refuse** `AUTH_MODE="demo"`. |
| `HOST` | `127.0.0.1` | non | Interface d'écoute. `0.0.0.0` pour accepter des connexions distantes. |
| `PORT` | `3000` | non | Port d'écoute. |

> ⚠️ `PORT` est converti par `parseInt`. Une valeur **vide** ne donne pas le
> défaut mais un port indéterminé : renseignez la ligne ou supprimez-la. Si le
> port `3000` est déjà occupé, utilisez par exemple `PORT="3100"` puis adaptez
> les URL en `http://127.0.0.1:3100/...`.

---

## Authentification

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `AUTH_MODE` | `token` | non | `token` ou `demo`. |
| `API_BODY_LIMIT_BYTES` | `65536` | non | Taille maximale d'un corps de requête. |
| `RATE_LIMIT_READ_MAX` | `240` | non | Requêtes de lecture par minute. |
| `RATE_LIMIT_WRITE_MAX` | `60` | non | Requêtes d'écriture par minute. |
| `RATE_LIMIT_DECISION_MAX` | `20` | non | Décisions d'approbation par minute. |

**`AUTH_MODE="token"`** — le défaut. Chaque appel `/api/…` exige un jeton
porteur, créé par `npm run auth:create-token`. Seul le condensat est stocké.

**`AUTH_MODE="demo"`** — enregistre **en plus** la route publique
`GET /api/auth/demo-session`, qui crée un utilisateur `demo-leader` de rôle
`leader` et renvoie un vrai jeton. C'est ce qui permet au cockpit de
s'authentifier tout seul.

> ⚠️ `AUTH_MODE="demo"` avec `NODE_ENV=production` **empêche le démarrage**.
> Cette route distribue un jeton valide à qui le demande.

Une valeur autre que `token` ou `demo` empêche également le démarrage, avec un
message nommant les modes acceptés.

Les limites de débit s'appliquent **avant** l'authentification. Elles sont
indexées sur le condensat du jeton présenté, jamais sur le secret ; un appel
anonyme est indexé sur l'adresse IP.

---

## Base de données

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `DATABASE_URL` | vide | non | Chaîne de connexion PostgreSQL. Vide = dépôt en mémoire. |
| `BUSINESS_MEMORY_PROVIDER` | `memory` | non | `memory` ou `postgres` — **où** les enregistrements métier sont stockés. |
| `BUSINESS_DATA_PROVIDER` | `demo` | non | `demo` ou `future_real_data` — **d'où** ils proviennent. |
| `BUSINESS_DATA_SOURCE_ID` | `demo` | non | Identifiant de la source de données. |
| `BUSINESS_PROVIDER_ADAPTER` | `demo` | non | Adaptateur de la source. |
| `RUN_POSTGRES_INTEGRATION` | `false` | non | `true` exécute les 34 tests d'intégration PostgreSQL. |
| `POSTGRES_HOST_PORT` | `5433` | non | Port hôte publié par `docker-compose.yml`. **Lu par Docker, pas par l'application.** |

### Les trois états de `DATABASE_URL`

| Valeur | Comportement |
| --- | --- |
| absente, vide, ou uniquement des espaces | Dépôt **en mémoire**. Choix explicite et valide. |
| `postgresql://…` ou `postgres://…` valide | Dépôt **Prisma / PostgreSQL**. |
| **renseignée mais invalide** | **`RepositoryConfigurationError`, l'application s'arrête.** |

Le troisième cas est un changement délibéré. Auparavant, une URL malformée
retombait en silence sur le dépôt mémoire : l'application démarrait, répondait à
tout, ne persistait rien, et ne le disait pas. Elle refuse désormais. L'erreur
ne contient **jamais** la valeur : une chaîne de connexion porte un mot de passe.

`BUSINESS_MEMORY_PROVIDER` et `BUSINESS_DATA_PROVIDER` sont **indépendants** :
le premier dit où les enregistrements sont rangés, le second d'où ils viennent.

> `BUSINESS_MEMORY_PROVIDER="postgres"` exige une `DATABASE_URL` valide, sinon
> une `BusinessMemoryConfigurationError` est levée.

---

## Documents H-KIDS

### Le design

Toutes les pièces H-KIDS — **facture, bon de livraison et bon de commande** — sont
dessinées par le code, dans le design adopté avec les bons de commande et les
devis : logo et coordonnées de la société (adresse du registre, DOUAR HARAKAT N
2153 TASSELTANT SAADA MARRAKECH), titre et objet, tableau à en-tête vert, totaux
sur bandeau vert, conditions de règlement, puis selon la pièce un bloc « Bon pour
accord » (commande) ou « Réception de la livraison » (BL). **Aucun gabarit n'est
à fournir** : seuls le logo du dépôt et une police `.ttf` sont nécessaires.

Les anciennes variables `HKIDS_INVOICE_TEMPLATE_PATH`,
`HKIDS_DELIVERY_NOTE_TEMPLATE_PATH` et leurs `_CHECKSUM` ne sont plus lues ; une
valeur restée dans un `.env` est sans effet.

### Les polices

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `HKIDS_DOCUMENT_FONT_PATH` | sondage automatique | non\* | Chemin absolu d'un `.ttf` pour le texte normal. |
| `HKIDS_DOCUMENT_BOLD_FONT_PATH` | sondage automatique | non\* | Chemin absolu d'un `.ttf` pour le gras. |
| `HKIDS_LOGO_PATH` | `assets/documents/hkids-logo.jpg` | non | Logo inséré dans le PDF et le document Word. |

\* **Nécessaires uniquement si le sondage automatique ne trouve rien.**

`pdf-lib` embarque un vrai fichier de police : un `.ttf` doit exister sur la
machine qui produit le PDF. Laissées vides, ces variables déclenchent un
sondage — chaque emplacement est testé en lecture, et le premier lisible gagne :

| Système | Emplacements sondés, dans l'ordre |
| --- | --- |
| Windows | `C:\Windows\Fonts\arial.ttf` · `arialbd.ttf` |
| macOS | `/System/Library/Fonts/Supplemental/Arial.ttf` · `Arial Bold.ttf`, puis `/Library/Fonts/` |
| Linux | Liberation Sans, puis DejaVu Sans, sous `/usr/share/fonts/truetype/…` et `/usr/share/fonts/…` |

**Rien n'est supposé** : un emplacement inexistant est écarté. Si aucun ne
répond, la génération s'arrête en nommant la variable. Une variable renseignée
est honorée telle quelle ou refusée si le fichier n'est pas lisible — jamais
remplacée par un candidat sondé.

Une valeur **vide** vaut « non configurée » pour les trois variables : copier
`.env.example` sans y toucher est sans effet.


---

## Validation de la passation

Dernière validation réalisée sur `main` :

```text
npm ci                 PASS
npm test               1121 tests / 1087 passed / 34 skipped / 0 failed
npm run lint           PASS
npm run build          PASS
npm run typecheck      PASS
npm run scan:secrets   PASS
git diff --check       PASS
serveur                PASS
/health                PASS
/app/                  PASS
Director/Finance       PASS
H-KIDS preview DEV     PASS
```

Les 34 tests ignorés sont les tests PostgreSQL conditionnés à
`RUN_POSTGRES_INTEGRATION="true"` et à une `DATABASE_URL` valide.

---

## Workflows / n8n

**Optionnel. Désactivé par défaut, et rien ne le réclame.**

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `WORKFLOW_PROVIDER` | `mock` | non | `mock` ou `n8n`. |
| `WORKFLOW_ENABLED` | `false` | non | `"true"` active la passerelle. Toute autre chaîne vaut faux. |
| `WORKFLOW_BASE_URL` | vide | **si activé** | Origine et chemin de base du webhook, en `http` ou `https`. |
| `N8N_WEBHOOK_PATH` | vide | **si activé** | Chemin du webhook, joint à `WORKFLOW_BASE_URL`. |
| `N8N_API_KEY_HEADER` | `X-AI-Agents-Token` | **si activé** | **Nom** de l'en-tête HTTP qui porte le jeton. Ce n'est pas un secret. |
| `N8N_API_KEY` | vide | **si activé** | **Valeur** du jeton. **Secret — jamais dans `.env.example`, jamais dans un commit.** |
| `N8N_TIMEOUT_MS` | `5000` | non | Entier positif de millisecondes. |

Il n'y a **pas** de seconde variable pour l'URL de base : l'adresse appelée est
`WORKFLOW_BASE_URL` + `N8N_WEBHOOK_PATH`.

### Ce qui se passe selon la configuration

| Configuration | Effet |
| --- | --- |
| `WORKFLOW_ENABLED="false"` (défaut) | Aucun client construit. `notify_delay_alert` **non enregistré** : 25 outils. `POST /api/production/delay-alerts` répond **409 `WORKFLOW_NOT_ENABLED`**. |
| `WORKFLOW_ENABLED="true"` + `WORKFLOW_PROVIDER="mock"` | **Démarrage refusé** — le fournisseur `mock` est hors ligne par conception. |
| `WORKFLOW_ENABLED="true"` sans `WORKFLOW_BASE_URL` appelable | **Démarrage refusé.** |
| `WORKFLOW_ENABLED="true"` + `WORKFLOW_PROVIDER="n8n"` + les quatre variables | Passerelle ouverte, 26 outils. |

Une des quatre variables requises manquante fait échouer le démarrage avec un
message nommant précisément laquelle. `N8N_TIMEOUT_MS` renseigné mais absurde
est refusé plutôt que silencieusement remplacé.

### Traitement du secret

`N8N_API_KEY` est lue **une seule fois**, dans `src/integrations/n8n-runtime.js`,
et passée directement à la fermeture du client HTTP. Elle n'est **jamais** une
propriété d'un objet : l'objet de configuration expose `hasApiKey` et rien
d'autre, `Object.keys(client)` vaut `["postWorkflowEvent"]`. Si n8n renvoie le
jeton dans un corps d'erreur, il est masqué avant journalisation.

---

## IA

**Le Director conversationnel et l'équipe d'agents s'activent avec
`OPENAI_API_KEY`.** Sans clé, le cockpit garde le Director à mots-clés et aucun
appel réseau vers OpenAI n'a lieu.

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | vide | **pour le Director IA** | **Secret.** Clé du compte OpenAI de l'entreprise. |
| `OPENAI_MODEL` | `gpt-5` | non | Modèle du Director et des agents. |
| `OPENAI_REASONING_EFFORT` | `low` | non | `minimal`, `low`, `medium`, `high` (modèles qui raisonnent). |
| `HKIDS_CATALOGUE_PATH` | `data/catalogue-hkids.xlsx` | non | Catalogue produits lu par le Director. |
| `HKIDS_PLANS_PATH` | `data/plans-director.json` | non | Où les plans d'action sont conservés. |
| `PLANNER_PROVIDER` | `deterministic` | non | Planificateur de `/api/director/requests` : `deterministic`, `stub_llm`, `llm_mock`, `llm_openai`. |
| `LLM_PROVIDER` | `mock` | non | Fournisseur de ce planificateur. |
| `AI_PROVIDER` | `openai` | non | Frontière fournisseur IA, distincte du planificateur. |
| `AI_PROVIDER_API_KEY` | vide | **si activé** | **Secret.** |
| `AI_PROVIDER_MODEL` | `gpt-5` | non | Modèle de la frontière IA. |
| `AI_PROVIDER_ENABLED` | `false` | non | `"true"` active la frontière. |

Le dossier `data/` est ignoré par Git : le dépôt est public, le catalogue et les
plans de l'entreprise n'y vont jamais.

Détail du planificateur : [`PLANNER_CONFIGURATION.md`](PLANNER_CONFIGURATION.md).

---

## Récapitulatif des variables sensibles

Trois variables portent une valeur secrète. **Aucune ne doit apparaître dans
`.env.example`, dans le code, dans la documentation ni dans un message de
commit :**

- `N8N_API_KEY`
- `OPENAI_API_KEY`
- `AI_PROVIDER_API_KEY`

`DATABASE_URL` en porte une aussi : elle contient un mot de passe.

Deux noms trompent l'œil et **ne sont pas** des secrets :
`N8N_API_KEY_HEADER` est un nom d'en-tête HTTP, et `AI_PROVIDER` est un nom de
fournisseur.

Contrôle automatique avant tout commit :

```bash
npm run scan:secrets
```

Un secret committé par erreur doit être **révoqué et remplacé**, pas seulement
retiré de l'historique.
