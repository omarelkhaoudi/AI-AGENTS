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

**Rien n'est obligatoire pour démarrer.** Toutes les variables ont un défaut
utilisable, et l'application démarre sur un `.env` intégralement copié depuis
`.env.example` sans y toucher.

---

## Application

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | non | Environnement déclaré. La seule valeur qui change un comportement est `production`, qui **refuse** `AUTH_MODE="demo"`. |
| `HOST` | `127.0.0.1` | non | Interface d'écoute. `0.0.0.0` pour accepter des connexions distantes. |
| `PORT` | `3000` | non | Port d'écoute. |

> ⚠️ `PORT` est converti par `parseInt`. Une valeur **vide** ne donne pas le
> défaut mais un port indéterminé : renseignez la ligne ou supprimez-la.

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

### Les gabarits — obligatoires pour générer

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `HKIDS_INVOICE_TEMPLATE_PATH` | `assets/documents/hkids/facture_reference.pdf` | **oui, pour générer une facture** | Chemin absolu du gabarit PDF de facture, 2 pages. |
| `HKIDS_DELIVERY_NOTE_TEMPLATE_PATH` | `assets/documents/hkids/bon_livraison_reference.pdf` | **oui, pour générer un BL** | Chemin absolu du gabarit PDF de bon de livraison, 3 pages. |
| `HKIDS_INVOICE_TEMPLATE_CHECKSUM` | vide | non | Verrou SHA-256 du gabarit de facture. |
| `HKIDS_DELIVERY_NOTE_TEMPLATE_CHECKSUM` | vide | non | Verrou SHA-256 du gabarit de bon de livraison. |

> 🔴 **Les deux gabarits ne sont pas livrés avec le dépôt.** Les originaux
> étaient des documents réels remplis, portant le nom d'une cliente, sa commande
> et ses montants — encore sélectionnables sous les zones que le générateur
> masque. Ils ont été retirés. **L'entreprise doit fournir ses propres gabarits
> vierges** avant que la génération produise quoi que ce soit.

Les chemins par défaut pointent vers `assets/documents/hkids/`, un répertoire qui
n'existe plus. Sans configuration, l'aperçu et la génération s'arrêtent sur
`HKIDS_TEMPLATE_MISSING`, et le message **nomme la variable à renseigner**.

Les coordonnées de mise en page sont calibrées sur la géométrie des documents
H-KIDS. Un gabarit d'un autre format rendra mal plutôt que d'échouer bruyamment,
sauf si son nombre de pages diffère — auquel cas il est refusé.

### Tester sans les gabarits officiels

```bash
npm run dev:templates
```

Écrit deux PDF vierges dans `assets/documents/hkids-local/` — répertoire **ignoré
par Git** — et affiche les deux lignes de configuration à coller dans `.env`.
Chaque page porte la mention **« GABARIT DE DEVELOPPEMENT - SANS VALEUR
OFFICIELLE - NE PAS TRANSMETTRE A UN CLIENT »**, qui apparaît sur tout document
généré à partir d'eux.

Ces gabarits servent uniquement à vérifier que la chaîne aperçu → génération →
téléchargement fonctionne. **Ils ne remplacent pas les gabarits officiels** : un
document produit à partir d'eux n'a ni en-tête, ni mentions légales, ni
habillage H-KIDS.

### Le verrou de checksum

Il n'a pas disparu avec les gabarits : il est devenu **facultatif**.

| Configuration | Comportement |
| --- | --- |
| Chemin seul | Aucun verrou. Le descriptif renvoie `locked: false` plutôt que de prétendre le contraire. |
| Chemin + checksum | Verrou actif : un octet changé et la génération s'arrête sur `HKIDS_TEMPLATE_CHECKSUM_MISMATCH`. |

### Les polices

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `HKIDS_DOCUMENT_FONT_PATH` | sondage automatique | non\* | Chemin absolu d'un `.ttf` pour le texte normal. |
| `HKIDS_DOCUMENT_BOLD_FONT_PATH` | sondage automatique | non\* | Chemin absolu d'un `.ttf` pour le gras. |
| `HKIDS_LOGO_PATH` | `assets/documents/hkids-logo.jpg` | non | Logo inséré dans le document Word. |

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

Une valeur **vide** vaut « non configurée » pour les six variables : copier
`.env.example` sans y toucher est sans effet.

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

**Optionnel. Désactivé par défaut, et le projet fonctionne entièrement sans.**

| Variable | Défaut | Obligatoire | Rôle |
| --- | --- | --- | --- |
| `PLANNER_PROVIDER` | `deterministic` | non | `deterministic`, `stub_llm`, `llm_mock`, `llm_openai`. |
| `LLM_PROVIDER` | `mock` | non | Fournisseur du planificateur LLM. |
| `OPENAI_API_KEY` | vide | **si `llm_openai`** | **Secret.** |
| `OPENAI_MODEL` | `gpt-5` | non | Modèle utilisé. |
| `AI_PROVIDER` | `openai` | non | Frontière fournisseur IA, distincte du planificateur. |
| `AI_PROVIDER_API_KEY` | vide | **si activé** | **Secret.** |
| `AI_PROVIDER_MODEL` | `gpt-5` | non | Modèle de la frontière IA. |
| `AI_PROVIDER_ENABLED` | `false` | non | `"true"` active la frontière. |

Seul `PLANNER_PROVIDER="llm_openai"` conduit à un appel réseau vers OpenAI. Les
trois autres planificateurs n'atteignent aucun réseau. `deterministic`, le
défaut, couvre le périmètre métier du CDC.

Détail : [`PLANNER_CONFIGURATION.md`](PLANNER_CONFIGURATION.md).

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
