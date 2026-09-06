# AI AGENTS

Système d'exploitation intelligent de l'entreprise, organisé autour d'un **Agent
Directeur** qui comprend une demande, la planifie, sollicite les agents
spécialisés, lit les données métier et produit une synthèse exploitable.

Le point d'entrée du dirigeant est unique : une question en langage naturel.

> **« Fais-moi le point sur mon entreprise aujourd'hui. »**

Sur cette question, le Directeur sollicite **les 10 agents**, exécute **15
étapes**, déduplique les signaux et rend un rapport en **10 rubriques**.

> **Vous voulez juste démarrer ?** Allez directement à
> [Démarrage rapide — Demo](#6-démarrage-rapide--demo). Trois commandes, aucune
> base de données, aucun compte externe.

---

## 1. Présentation

L'objectif n'est pas de juxtaposer des chatbots indépendants, mais de construire
une équipe organisée où :

- le dirigeant s'adresse **au Directeur uniquement**, jamais à chaque agent ;
- le Directeur détermine quels agents solliciter et dans quel ordre ;
- chaque agent n'accède qu'aux informations nécessaires à sa mission ;
- les actions sensibles sont **préparées, puis soumises à validation humaine** ;
- les données métier de l'entreprise sont la source de vérité, pas l'historique
  de conversation.

Le but n'est pas de remplacer l'équipe humaine. L'IA gère l'information,
surveille les processus, prépare le travail et détecte les problèmes ; la
décision reste humaine.

**Ce que le projet fait aujourd'hui, en une phrase :** il répond à une question
de dirigeant à partir de données de démonstration, prépare un devis depuis une
fiche produit sans jamais inventer un montant, et bloque toute action sensible
derrière une approbation humaine.

> ⚠️ **Les données métier livrées sont des données de démonstration.** Elles ne
> sont pas les données de l'entreprise. Aucun raccordement à des données réelles
> n'est effectué par défaut.

---

## 2. Architecture générale

```
Dirigeant
   │  question en langage naturel
   ▼
Director / Orchestrator          planifie, délègue, consolide
   │
   ▼
Agents spécialisés (10)          chacun borné à sa mission
   │
   ▼
Tools (25)                       une capacité vérifiable, autorisée
   │
   ▼
Business Memory                  15 domaines métier, contrat unique
   │
   ▼
PostgreSQL / mémoire             deux implémentations, résultats identiques
```

| Couche | Rôle |
| --- | --- |
| **Director** | Reçoit la demande, construit un plan validé, délègue étape par étape, consolide les résultats et hiérarchise ce qui nécessite une décision. |
| **Agents** | Dix rôles métier. Un agent ne choisit pas ses outils : le planificateur les lui assigne, et ses permissions bornent ce qu'il peut atteindre. |
| **Tools** | Une capacité unitaire, avec ses agents autorisés, sa permission requise et ses domaines de sécurité. C'est le seul chemin vers la donnée. |
| **Business Memory** | Contrat unique de lecture sur quinze domaines. Un outil ne connaît pas le stockage sous-jacent. |
| **Stockage** | PostgreSQL via Prisma 7, ou une implémentation en mémoire. Les deux renvoient des enregistrements identiques. |

**Les 10 agents** : `director`, `commercial`, `finance`, `production`,
`purchasing`, `hr`, `after_sales`, `marketing`, `community_manager`, `legal`.
Le Community Manager rend compte au Marketing, pas au Directeur.

**25 outils** sont enregistrés par défaut. Un 26ᵉ, `notify_delay_alert`,
n'apparaît que si la passerelle n8n est activée — voir [§12](#12-n8n).

Le planificateur par défaut est **déterministe** : il sélectionne les agents en
analysant la formulation de la demande et leur assigne une liste d'outils fixe.
**Aucun modèle de langage n'est sollicité dans cette configuration.**

Détail complet des agents, de leurs outils, permissions et domaines de sécurité :
[`docs/AGENTS.md`](docs/AGENTS.md). Architecture technique :
[`docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md`](docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md).

### Le rapport du Directeur

Dix rubriques, conformément au §31 du cahier des charges :

| Rubrique | Ce qu'elle porte |
| --- | --- |
| **CE QUI VA BIEN** | Commandes à l'heure, signaux positifs |
| **RETARDS / PROBLEMES** | Commandes en danger ou en retard, réclamations qualité |
| **A ENCAISSER** | Créances, montant et devise, ancienneté du retard |
| **A COMMANDER** | Manques de matière et besoins d'achat |
| **RISQUES / BLOCAGES** | Ce qui menace un engagement, sans arbitrage demandé |
| **DECISIONS NECESSAIRES** | Ce qui attend un arbitrage du dirigeant |
| **CE QUI NECESSITE UNE ACTION COMMERCIALE** | Devis sans réponse, relances |
| **CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION** | Campagnes et contenus |
| **CE QUI NECESSITE UNE INTERVENTION SAV** | Dossiers après-vente ouverts |
| **CE QUI PRESENTE UN RISQUE JURIDIQUE** | Contrats, clauses, échéances |

Un même signal remonté par deux outils n'est compté qu'une fois.

---

## 3. Prérequis

| Élément | Version | Obligatoire |
| --- | --- | --- |
| **Node.js** | **20 ou supérieur** | **oui** |
| npm | fourni avec Node.js | oui |
| Git | — | oui, pour cloner |
| Docker | — | non — seulement pour le PostgreSQL local ([§7](#7-mode-postgresql-persistant)) |
| PostgreSQL | 14 ou supérieur | non — le mode mémoire fonctionne sans |
| Compte OpenAI | — | non — désactivé par défaut ([§11](#11-openai)) |
| Compte n8n | — | non — désactivé par défaut ([§12](#12-n8n)) |

Vérifier Node.js :

```bash
node --version
```

Le projet est développé sous Windows et n'utilise aucune dépendance native. Là
où une commande diffère selon le système, les trois variantes sont données.

---

## 4. Installation

```bash
git clone https://github.com/omarelkhaoudi/AI-AGENTS.git
```

```bash
cd AI-AGENTS
```

```bash
npm install
```

Aucune étape de compilation : le projet est en JavaScript ESM natif.

---

## 5. Configuration `.env`

Toute la configuration passe par des variables d'environnement.
`.env.example` est la référence versionnée ; **il ne contient aucune valeur
réelle**. `.env` est ignoré par Git et ne doit jamais être commité.

Copier le modèle — **choisissez la ligne de votre système** :

```bash
cp .env.example .env
```

```text
Windows PowerShell :  Copy-Item .env.example .env
Windows cmd.exe    :  copy .env.example .env
macOS / Linux      :  cp .env.example .env
```

**Aucune variable n'est obligatoire pour démarrer.** Toutes ont un défaut
utilisable. La référence complète, variable par variable, avec son défaut et le
moment où elle devient nécessaire, est dans
**[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)**.

Comment `.env` est lu — c'est une particularité du projet :

- le fichier est chargé par un mécanisme **interne** au dépôt
  (`src/load-dotenv.js`), il n'y a **aucune dépendance `dotenv`** ;
- il est lu par `npm start`, `db:seed`, `db:seed:business`, `auth:create-token`
  et `data:ingest` ;
- **une variable déjà exportée dans le shell gagne toujours** sur le fichier ;
- le fichier n'est lu **qu'au démarrage** : après une modification, redémarrez.

> **Prisma 7 ne lit pas `.env` non plus.** `npm run db:generate` et
> `npm run db:migrate` résolvent `DATABASE_URL` via `prisma.config.js`, depuis
> l'environnement du processus. Exportez-la dans le shell avant de les lancer.

---

## 6. Démarrage rapide — Demo

Le chemin le plus court : **aucune base de données, aucun compte externe**.

Dans `.env`, une seule ligne à changer :

```text
AUTH_MODE="demo"
```

Puis :

```bash
npm start
```

L'API écoute sur **http://127.0.0.1:3000**. Vérification immédiate :

```bash
curl http://127.0.0.1:3000/health
```

Réponse attendue : `{"status":"ok","service":"ai-agents","timestamp":"..."}`

### Ouvrir le cockpit

Ouvrez **http://127.0.0.1:3000/app/** dans un navigateur.

La racine **http://127.0.0.1:3000/** sert la même page.

### Comment fonctionne le jeton de démonstration

En mode `demo`, et **seulement** dans ce mode, une route publique
supplémentaire est enregistrée : `GET /api/auth/demo-session`. Elle crée un
utilisateur `demo-leader` de rôle `leader`, émet un vrai jeton porteur et le
renvoie.

Le cockpit s'en sert tout seul : au premier appel, il regarde
`sessionStorage`, et s'il n'y trouve rien il appelle
`/api/auth/demo-session`, garde le jeton en session et l'envoie ensuite dans
l'en-tête `Authorization: Bearer …` de chaque requête. **Vous n'avez rien à
saisir.**

Pour obtenir le même jeton en ligne de commande :

```bash
curl http://127.0.0.1:3000/api/auth/demo-session
```

> ⚠️ `AUTH_MODE="demo"` est **refusé** si `NODE_ENV=production` : l'application
> ne démarre pas. C'est délibéré — cette route distribue un jeton valide à qui
> le demande.
>
> ⚠️ En `AUTH_MODE="token"`, cette route n'existe pas et le cockpit affiche
> « Authentification requise: aucun jeton disponible ». Voir [§8](#8-authentification-token).

### Ce que fait le cockpit

| Section | Ce qu'elle permet |
| --- | --- |
| **Director IA** | Poser la question dirigeant et lire la synthèse, le plan et les agents sollicités |
| **Test Hiba — Préparation de devis** | Préparer un devis depuis une fiche produit, sans qu'aucun prix soit inventé |
| **Documents H-KIDS** | Aperçu puis génération d'une facture ou d'un bon de livraison ([§10](#10-génération-des-documents-h-kids)) |
| **Actions nécessitant votre validation** | Approuver ou refuser ce que les agents ont préparé |
| **Voix** | Emplacement réservé — **non implémenté** |
| **Historique** | Les requêtes passées |

### Les routes de l'API

Toutes exigent `Authorization: Bearer <jeton>`, sauf `/health` et
`/api/auth/demo-session`.

| Méthode | Route | Rôle |
| --- | --- | --- |
| `GET` | `/health` | État du service, sans authentification |
| `GET` | `/api/auth/demo-session` | Jeton de démonstration — **mode demo uniquement** |
| `POST` | `/api/director/requests` | Question dirigeant, corps `{ "message": "..." }` |
| `POST` | `/api/requests` | Création d'une requête brute |
| `GET` | `/api/requests/:id` | Relecture d'une requête |
| `GET` | `/api/approvals` | Approbations en attente |
| `GET` | `/api/approvals/:id` | Une approbation |
| `POST` | `/api/approvals/:id/approve` | Approuver |
| `POST` | `/api/approvals/:id/reject` | Refuser |
| `POST` | `/api/quotes/datasheet` | Préparer un devis depuis une fiche produit |
| `POST` | `/api/documents/preview` | Aperçu validé d'un document H-KIDS |
| `POST` | `/api/documents/generate` | Génération après confirmation |
| `GET` | `/api/documents/:id/download` | Téléchargement du PDF ou du DOCX |
| `POST` | `/api/production/delay-alerts` | Alerte de retard vers n8n — **si la passerelle est activée** |

---

## 7. Mode PostgreSQL persistant

**PostgreSQL n'est pas nécessaire pour démarrer.** Sans `DATABASE_URL`,
l'application utilise un dépôt en mémoire : tout fonctionne, et **les données
disparaissent à l'arrêt du processus**. C'est le mode par défaut, et le mode de
la démonstration.

La persistance réelle demande PostgreSQL.

### Démarrer la base

Un `docker-compose.yml` est fourni. Il expose PostgreSQL **sur le port 5433**,
pas 5432 : une instance déjà présente sur le port par défaut est courante, et
entrer en conflit avec elle serait pire qu'un port inhabituel.

```bash
docker compose up -d db
```

Sans Docker, une installation locale convient — procédure dans
[`docs/POSTGRESQL_SETUP.md`](docs/POSTGRESQL_SETUP.md).

### Configurer

Dans `.env` :

```text
DATABASE_URL="postgresql://ai_agents:<mot_de_passe>@localhost:5433/ai_agents?schema=public"
BUSINESS_MEMORY_PROVIDER="postgres"
```

Les identifiants du conteneur local sont écrits en clair dans
`docker-compose.yml`. Ce sont des identifiants de développement jetables : **ne
les réutilisez nulle part ailleurs.**

> ⚠️ **Une `DATABASE_URL` renseignée mais invalide arrête l'application** avec
> une erreur explicite. Elle ne retombe plus en silence sur le dépôt mémoire.
> Laissée vide, elle signifie « pas de base », ce qui reste parfaitement
> valide. Voir [§14](#14-dépannage).

### Préparer le schéma et les données

Dans cet ordre :

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
npm run db:seed:business -- --apply
```

| Commande | Effet |
| --- | --- |
| `db:generate` | Génère le client Prisma |
| `db:migrate` | Applique les **6** migrations versionnées |
| `db:seed` | Sème les 10 agents et leurs permissions |
| `db:seed:business -- --apply` | Charge les données métier de démonstration |

`db:seed:business` est en **simulation par défaut** : sans `--apply`, il valide
et n'écrit rien. Les deux seeds sont **idempotents** — les relancer ne crée pas
de doublons.

Le schéma compte **26 modèles Prisma** répartis entre l'orchestration et la
mémoire métier. Détail :
[`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md).

---

## 8. Authentification Token

`AUTH_MODE="token"` est le **défaut**. Chaque appel `/api/…` exige un jeton
porteur. Seul le condensat du jeton est stocké, jamais le secret.

Créer un jeton :

```bash
npm run auth:create-token -- --user-id=hiba --role=leader
```

Le secret est affiché **une seule fois**, à la création. Notez-le.

Options : `--user-id` (obligatoire), `--name`, `--role`, `--email`,
`--display-name`. Rôles disponibles : `viewer`, `operator`, `approver`,
`leader`. Approuver une action demande au moins `approver`.

Utiliser le jeton :

```bash
curl -H "Authorization: Bearer <votre_jeton>" http://127.0.0.1:3000/api/approvals
```

> **Ce script lit `.env`.** Ce n'était pas le cas auparavant : une
> `DATABASE_URL` présente uniquement dans `.env` était invisible, le jeton
> était écrit dans un dépôt en mémoire, affiché, puis perdu à la fin du
> processus. C'est corrigé — avec une `DATABASE_URL` valide, le jeton est
> persisté en base.

> ⚠️ **Le cockpit ne sait pas encore saisir un jeton.** En mode `token`, il
> affiche « Authentification requise: aucun jeton disponible ». Pour une
> démonstration au navigateur, utilisez `AUTH_MODE="demo"` ; le mode `token`
> s'utilise aujourd'hui via l'API.

---

## 9. Tests et validation

Quatre contrôles, tous exécutables hors ligne :

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run build
```

```bash
npm run scan:secrets
```

| Commande | Ce qu'elle fait |
| --- | --- |
| `npm test` | Suite complète, via le lanceur natif `node --test` |
| `npm run lint` | Validation syntaxique de chaque fichier JavaScript |
| `npm run build` | Validation de build — **aucune compilation n'est requise**, et la commande le dit |
| `npm run scan:secrets` | Recherche de secrets en dur, motifs et heuristiques |
| `npm run typecheck` | TypeScript n'est pas configuré ; la commande le dit et rend la main |

### Résultat mesuré

Dernière exécution vérifiée, **sans PostgreSQL** :

```text
tests     805
pass      771
fail        0
skipped    34
```

`lint`, `build` et `scan:secrets` : sans erreur.

**Les 34 tests ignorés sont exactement les tests d'intégration PostgreSQL.**
Ils sont répartis sur 12 fichiers, tous conditionnés à `RUN_POSTGRES_INTEGRATION`
et à une `DATABASE_URL` valide. Aucun autre test n'est ignoré pour une autre
raison.

### Lever les 34 ignorés

Avec PostgreSQL démarré et migré, dans `.env` :

```text
RUN_POSTGRES_INTEGRATION="true"
DATABASE_URL="postgresql://ai_agents:<mot_de_passe>@localhost:5433/ai_agents?schema=public"
```

Ces deux variables doivent être **dans l'environnement du processus de test**.
Le lanceur `node --test` ne lit pas `.env` : exportez-les.

```bash
export RUN_POSTGRES_INTEGRATION=true && export DATABASE_URL="postgresql://..." && npm test
```

```text
Windows PowerShell :  $env:RUN_POSTGRES_INTEGRATION="true"; $env:DATABASE_URL="postgresql://..."; npm test
Windows cmd.exe    :  set RUN_POSTGRES_INTEGRATION=true && set DATABASE_URL=postgresql://... && npm test
```

Les 34 tests s'exécutent alors au lieu d'être ignorés. **Le nombre de tests
réussis dans cette configuration n'est pas mesuré dans ce document** : ne le
supposez pas, exécutez-le.

### Trois familles de tests méritent d'être signalées

- **Équivalence Memory ↔ PostgreSQL** — le même rapport doit sortir des deux
  implémentations, rubrique par rubrique.
- **Cohérence de la documentation** — la suite échoue si un agent, un outil, un
  domaine, un modèle ou une migration est ajouté sans être documenté dans
  `docs/`, ou si un `npm run …` cité dans `docs/` n'existe pas.
- **Non-dérive des permissions** — un instantané figé du modèle de moindre
  privilège, qui échoue à tout élargissement non délibéré.

---

## 10. Génération des documents H-KIDS

Le projet génère deux documents sur les gabarits officiels H-KIDS : **facture**
et **bon de livraison**, chacun en **PDF et en Word**.

> 🔴 **Les deux gabarits ne sont pas livrés avec le dépôt.** Les originaux
> étaient des documents réels remplis, portant le nom d'une cliente, sa commande
> et ses montants. Ils ont été retirés. **L'entreprise doit fournir ses propres
> gabarits vierges**, puis les nommer dans `.env` :
>
> ```text
> HKIDS_INVOICE_TEMPLATE_PATH="/chemin/absolu/facture_vierge.pdf"        # 2 pages
> HKIDS_DELIVERY_NOTE_TEMPLATE_PATH="/chemin/absolu/bl_vierge.pdf"       # 3 pages
> ```
>
> Sans eux, l'aperçu et la génération s'arrêtent sur `HKIDS_TEMPLATE_MISSING`,
> avec un message nommant la variable à renseigner. Le reste du projet n'en
> dépend pas.

**Pour tester la chaîne complète en attendant les gabarits officiels**, le
projet sait fabriquer des gabarits de développement :

```bash
npm run dev:templates
```

Deux PDF vierges au bon nombre de pages sont écrits dans
`assets/documents/hkids-local/`, un répertoire **ignoré par Git**, et la commande
affiche les deux lignes à coller dans `.env`. Chaque page porte la mention
**« GABARIT DE DEVELOPPEMENT - SANS VALEUR OFFICIELLE - NE PAS TRANSMETTRE A UN
CLIENT »**, qui se retrouve sur tout document produit. Ce ne sont **pas** des
gabarits H-KIDS : ils n'ont ni en-tête, ni mentions légales, ni habillage.

Trois garanties structurent cette fonctionnalité :

1. **Rien n'est inventé.** Un champ manquant, une valeur ambiguë ou un total qui
   ne tombe pas juste arrête la génération et nomme le problème.
2. **Un aperçu avant tout.** La génération exige un jeton d'aperçu qui
   correspond exactement à ce qui a été relu.
3. **Le gabarit peut être verrouillé** par un condensat SHA-256, renseigné dans
   `HKIDS_INVOICE_TEMPLATE_CHECKSUM` / `HKIDS_DELIVERY_NOTE_TEMPLATE_CHECKSUM`.
   Le verrou est facultatif : sans lui, la génération fonctionne et le dit.

Depuis le cockpit : section **Documents H-KIDS**, remplir, **Aperçu**, relire,
puis **Valider et générer**. Les deux fichiers apparaissent en téléchargement.

Les fichiers générés sont écrits dans **`assets/documents/generated/`**, un
répertoire **ignoré par Git** : ces documents portent des données client.

> ⚠️ **La génération PDF exige aussi une police `.ttf` présente sur la machine.**
> Sans configuration, le projet en cherche une aux emplacements habituels de
> Windows, macOS et Linux. S'il n'en trouve aucune, il s'arrête en nommant la
> variable à renseigner — il n'utilise jamais une police de remplacement
> silencieuse. Voir [§14](#14-dépannage).

Variables, verrous et messages d'erreur :
[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md), section « Documents H-KIDS ».

---

## 11. OpenAI

**Désactivé par défaut, et le projet fonctionne entièrement sans.** Le
planificateur déterministe couvre le périmètre métier ; aucun appel réseau vers
OpenAI n'est effectué tant que la configuration ne le demande pas.

Pour activer un vrai modèle :

```text
PLANNER_PROVIDER="llm_openai"
OPENAI_API_KEY="<votre cle, jamais commitee>"
OPENAI_MODEL="gpt-5"
```

`PLANNER_PROVIDER` accepte `deterministic` (défaut), `stub_llm`, `llm_mock` et
`llm_openai`. Les trois premiers n'atteignent aucun réseau.

Détail : [`docs/PLANNER_CONFIGURATION.md`](docs/PLANNER_CONFIGURATION.md).
Variables : [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).

---

## 12. n8n

**Optionnel et désactivé par défaut.** `WORKFLOW_ENABLED="false"` et
`WORKFLOW_PROVIDER="mock"` dans `.env.example`. Sans activation :

- aucun client n8n n'est construit ;
- l'outil `notify_delay_alert` **n'est pas enregistré** — le registre compte 25
  outils au lieu de 26 ;
- `POST /api/production/delay-alerts` répond **409 `WORKFLOW_NOT_ENABLED`** ;
- **aucun appel sortant n'est possible.**

Pour activer la passerelle, les sept variables sont décrites dans
[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md). Le principe :

```text
WORKFLOW_PROVIDER="n8n"
WORKFLOW_ENABLED="true"
WORKFLOW_BASE_URL="https://<votre-instance>/webhook"
N8N_WEBHOOK_PATH="<chemin du webhook>"
N8N_API_KEY_HEADER="X-AI-Agents-Token"
N8N_API_KEY="<votre jeton, jamais commite>"
```

Ce que le code garantit, et qui compte plus que la configuration :

- **une alerte ne part jamais sans approbation humaine.** L'appel HTTP a lieu à
  l'approbation, pas à la création de l'alerte ;
- une approbation ne peut pas être rejouée pour envoyer deux fois ;
- le jeton n'est jamais une propriété d'un objet : il vit dans une fermeture, et
  la configuration n'expose que `hasApiKey` ;
- la réponse de n8n **doit être du JSON valide**, sinon l'exécution est
  enregistrée en échec.

> ⚠️ **Cette passerelle n'a jamais été validée par un appel réel** au moment de
> cette livraison. Elle est entièrement testée hors ligne, avec un client
> injecté. Voir [§15](#15-état-du-mvp).

---

## 13. Structure du projet

```
src/
  api/              Fastify, routes, authentification, limitation de debit
  agents/           Les 10 agents, permissions, seed
  director/         Planification et consolidation du rapport
  tools/            Les 25 outils et leurs adaptateurs
  business-memory/  Contrat de lecture, 15 domaines, memoire et Prisma
  documents/        Generation H-KIDS : validation, PDF, DOCX, verrous
  security/         Jetons, roles, permissions, domaines, approbations
  integrations/     Frontieres externes : n8n, fournisseur IA
  workflows/        Contrat des evenements de workflow
  persistence/      Depots memoire et Prisma
  observability/    Audit
  frontend/         Le cockpit : index.html, app.js, styles.css
  demo/             Donnees de demonstration
  config.js         Lecture de la configuration
  load-dotenv.js    Chargement de .env, sans dependance
  server.js         Point d'entree de npm start

scripts/            Seeds, jetons, lint, build, scan de secrets, ingestion
prisma/             schema.prisma et 6 migrations
test/               La suite complete
docs/               Documentation
assets/documents/   Logo H-KIDS. Les gabarits PDF ne sont PAS versionnes.
  generated/        Documents produits — ignore par Git
```

### Documentation

| Document | Contenu |
| --- | --- |
| [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) | **Toutes les variables d'environnement**, par catégorie |
| [`docs/AGENTS.md`](docs/AGENTS.md) | Les 10 agents, outils, permissions, domaines de sécurité |
| [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) | Les 26 modèles, les 15 domaines, les migrations |
| [`docs/POSTGRESQL_SETUP.md`](docs/POSTGRESQL_SETUP.md) | Installation de la base, Docker ou local |
| [`docs/BACKUP_AND_RESTORE.md`](docs/BACKUP_AND_RESTORE.md) | Sauvegarde, restauration, reprise du projet |
| [`docs/PLANNER_CONFIGURATION.md`](docs/PLANNER_CONFIGURATION.md) | Choix du planificateur |
| [`docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md`](docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md) | Architecture technique détaillée |
| [`docs/AGENT-MVP-BOUNDARIES.md`](docs/AGENT-MVP-BOUNDARIES.md) | Frontières du MVP |

Quatre documents décrivent l'**instantané V1** figé au commit `c2c1d89` et
portent leurs chiffres d'alors : [`DELIVERY_V1_MVP.md`](docs/DELIVERY_V1_MVP.md),
[`V1_INSTALLATION_GUIDE.md`](docs/V1_INSTALLATION_GUIDE.md),
[`V1_DEMO_GUIDE.md`](docs/V1_DEMO_GUIDE.md),
[`V1_TEST_REPORT.md`](docs/V1_TEST_REPORT.md). **Ce README fait foi pour l'état
courant.**

---

## 14. Dépannage

### Le port 3000 est déjà utilisé

Le port et l'hôte se règlent par `PORT` et `HOST` dans `.env` — défauts `3000`
et `127.0.0.1`. Les deux sont lus **au démarrage seulement**.

```text
PORT="3100"
```

Identifier ce qui occupe le port :

```text
Windows PowerShell :  Get-NetTCPConnection -LocalPort 3000
Windows cmd.exe    :  netstat -ano | findstr :3000
macOS / Linux      :  lsof -i :3000
```

> Ne laissez pas `PORT` vide : la valeur est convertie par `parseInt`, et une
> chaîne vide donne un port indéterminé. Renseignez-la ou retirez la ligne.

### `.env` semble ignoré

Trois causes, dans l'ordre de fréquence :

1. **Le serveur n'a pas été redémarré.** Le fichier n'est lu qu'au démarrage.
2. **La variable est déjà exportée dans le shell.** L'environnement gagne
   toujours sur le fichier — c'est délibéré. Vérifiez avec
   `echo $env:MA_VARIABLE` (PowerShell) ou `echo $MA_VARIABLE` (bash).
3. **Le fichier n'est pas au bon endroit.** Il est cherché à `.env` **relatif au
   répertoire courant**, pas au répertoire du script. Lancez les commandes
   depuis la racine du dépôt.

Rappel : `npm run db:generate` et `npm run db:migrate` passent par Prisma, qui
ne lit pas `.env`. Exportez `DATABASE_URL` avant.

### `DATABASE_URL` invalide

```text
RepositoryConfigurationError: DATABASE_URL is set but is not a valid PostgreSQL
connection string. Fix it, or remove it to run on the in-memory repository.
  code: 'DATABASE_URL_INVALID'
```

C'est **volontaire**. Une URL renseignée mais qui n'est ni `postgresql://` ni
`postgres://` arrête l'application au lieu de retomber en silence sur le dépôt
mémoire — un comportement qui donnait une application démarrée, répondante, qui
ne persistait rien et ne le disait pas.

Deux issues : corriger l'URL, ou **vider complètement** `DATABASE_URL` pour
choisir explicitement le mode mémoire. Une valeur vide ou faite d'espaces est
acceptée comme « pas de base ».

### Gabarit H-KIDS absent

```text
Le template H-KIDS hkids-invoice-reference est introuvable. Renseignez
HKIDS_INVOICE_TEMPLATE_PATH avec le chemin d'un gabarit fourni par l'entreprise.
```

C'est **l'état normal d'un dépôt fraîchement cloné** : les gabarits ne sont pas
versionnés. Renseignez `HKIDS_INVOICE_TEMPLATE_PATH` et
`HKIDS_DELIVERY_NOTE_TEMPLATE_PATH` avec des chemins absolus vers les gabarits
vierges fournis par l'entreprise — 2 pages pour la facture, 3 pour le bon de
livraison. Voir [§10](#10-génération-des-documents-h-kids).

Message voisin :

```text
Le template H-KIDS ... ne correspond pas au checksum attendu.
```

Un verrou SHA-256 est configuré et le fichier ne lui correspond plus. Corrigez
le fichier, ou mettez le condensat à jour, ou videz la variable de checksum pour
retirer le verrou.

### Police PDF absente

```text
No regular font was found on this machine. Set HKIDS_DOCUMENT_FONT_PATH to the
absolute path of a .ttf file.
```

Renseignez les deux variables avec des **chemins absolus** vers des fichiers
`.ttf` :

```text
HKIDS_DOCUMENT_FONT_PATH="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
HKIDS_DOCUMENT_BOLD_FONT_PATH="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
```

Message voisin, cause différente :

```text
HKIDS_DOCUMENT_FONT_PATH points to a font file that cannot be read: <chemin>
```

Là, la variable est renseignée mais le fichier n'existe pas ou n'est pas
lisible. Le projet **ne remplace jamais** une police configurée par une autre.

### PostgreSQL : vérifier que le conteneur tourne

```bash
docker compose ps
```

La colonne d'état doit indiquer `running` et le service `healthy` — le conteneur
ne se déclare prêt qu'une fois qu'il accepte des requêtes.

```bash
docker compose logs db
```

Tester la connexion depuis le conteneur :

```bash
docker compose exec db pg_isready -U ai_agents -d ai_agents
```

Si le port 5433 est déjà pris, changez `POSTGRES_HOST_PORT` dans `.env` **et**
le port dans `DATABASE_URL`.

### n8n

**n8n n'est nécessaire à aucun démarrage standard.** S'il est désactivé, rien
ne le réclame et aucune fonctionnalité de ce README n'en dépend, à la seule
exception de `POST /api/production/delay-alerts`, qui répond alors
`409 WORKFLOW_NOT_ENABLED` — et c'est la réponse correcte.

Si vous l'activez et que l'appel échoue, l'erreur porte un `boundaryCode` :
`N8N_UNEXPECTED_STATUS` (le webhook n'a pas répondu 2xx — workflow inactif ou
en-tête d'authentification refusé), `N8N_INVALID_RESPONSE` (la réponse n'était
pas du JSON), `N8N_REQUEST_TIMEOUT`, `N8N_REQUEST_FAILED`.

---

## 15. État du MVP

| Domaine | État |
| --- | --- |
| Orchestration | ✅ Plan validé, exécution étape par étape, consolidation |
| Les 10 agents | ✅ Missions, permissions et outils réels |
| Tools | ✅ **25** enregistrés — 26 avec la passerelle n8n |
| Business Memory | ✅ 15 domaines, contrat unique |
| PostgreSQL | ✅ 26 modèles, **6** migrations, équivalence vérifiée |
| Sécurité | ✅ Authentification, moindre privilège, domaines de sécurité |
| Validation humaine | ✅ 3 niveaux, approbation obligatoire pour toute action non `read_analyze` |
| Audit | ✅ Événements structurés, causes sans message brut |
| Director §31 | ✅ Les 10 rubriques |
| Documents H-KIDS | 🟡 Moteur complet et testé — **les gabarits doivent être fournis par l'entreprise** |
| Interface | 🟡 Cockpit fonctionnel, volontairement minimal — **pas de saisie de jeton** |
| Planificateur LLM | 🟡 Implémenté derrière une interface, **désactivé par défaut** |
| n8n / workflows | 🟡 Implémenté et testé hors ligne, **désactivé par défaut, jamais validé par un appel réel** |
| Voix | 🔴 **Non intégré** — emplacement réservé dans le cockpit |
| Données réelles de l'entreprise | 🔴 **Non raccordées** — les données livrées sont des données de démonstration |

### Sécurité et validation humaine

**Quatre contrôles indépendants** avant qu'un outil s'exécute :

1. l'outil nomme les agents autorisés à l'appeler ;
2. l'agent détient la permission requise (`read_analyze`, `prepare_action`,
   `execute_action`) ;
3. l'agent détient **tous** les domaines de sécurité que l'outil lit ;
4. **tout outil dont la permission n'est pas `read_analyze` s'arrête et attend
   une décision humaine** — sans exception.

Un agent détient exactement les domaines de sécurité que ses propres outils
exigent, ni plus ni moins. Ce modèle est figé par un test.

### Limites assumées

- Les données métier sont **de démonstration**.
- La passerelle n8n n'a pas été validée par un appel réel.
- Le cockpit ne sait pas saisir un jeton : le mode `token` s'utilise via l'API.
- Un devis approuvé n'est **pas** persisté comme devis : l'outil le prépare,
  l'approbation le débloque, rien ne l'archive encore.
- Il n'existe ni sauvegarde planifiée ni restauration à un instant donné.
- Le rang des enregistrements métier est stocké dans un champ JSON plutôt que
  dans une colonne indexée.

### Prochaines étapes

1. Compléter les agrégats métier restants du §29 du CDC.
2. Valider la passerelle n8n par un premier appel réel.
3. Raccorder les données réelles de l'entreprise — **après validation
   explicite**.
4. Enrichir le cockpit, à commencer par la saisie d'un jeton.
5. Commandes vocales, après validation du noyau.
6. Sauvegardes planifiées et supervision avant toute mise en production.

---

## 📄 Licence

**Aucune licence n'est définie à ce jour.** `package.json` n'en déclare pas et
le dépôt n'en contient aucune. En l'absence de licence explicite, tous les
droits sont réservés par défaut.

La propriété de l'infrastructure — comptes, dépôt, base de données, hébergement
— revient à l'entreprise, conformément au §20 du cahier des charges.
