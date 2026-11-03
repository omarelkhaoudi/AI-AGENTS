# AI AGENTS

Système d'exploitation intelligent de l'entreprise, organisé autour d'un **Agent
Directeur** qui comprend une demande, la planifie, sollicite les agents
spécialisés, lit les données métier et produit une synthèse exploitable.

Le point d'entrée du dirigeant est unique : une conversation en langage naturel
avec le **Director IA**, un vrai agent (modèle OpenAI) qui joue le rôle d'un
directeur général : il reçoit un objectif, mesure l'écart sur les données, bâtit
la stratégie, donne à chaque responsable (Commercial, Marketing, Finance,
Production, Achats…) sa part chiffrée, suit le plan dans le temps et ne fait rien
d'irréversible sans validation humaine. L'exécution — devis, factures, messages —
revient aux responsables.

> **« Je veux qu'on fasse 100 000 DH de chiffre d'affaires ce mois. Quelle stratégie ? »**
>
> **« Qu'est-ce qui risque de bloquer cette semaine et qu'est-ce que je dois décider ? »**

> **Vous installez le projet ?** Suivez [Installation / Passation](#installation--passation)
> juste en dessous. Sans clé OpenAI ni base de données, la
> [démo](#6-démarrage-rapide--demo) démarre aussi en trois commandes.

---

## Installation / Passation

Cette section est le chemin recommandé pour installer le projet sur un poste neuf
(par exemple chez Hiba) et le vérifier. Comptez une vingtaine de minutes.

### Prérequis

- **Node.js 20 ou supérieur** — <https://nodejs.org>, bouton « LTS »
- **Git** — <https://git-scm.com/download/win>
- npm, fourni avec Node.js
- **Une clé API OpenAI** du compte de l'entreprise (§20 du CDC) : c'est elle qui
  fait du Director et des agents de vrais agents IA

Vérifier dans PowerShell :

```powershell
node -v
git --version
```

### Cloner

```powershell
git clone https://github.com/omarelkhaoudi/AI-AGENTS.git
cd AI-AGENTS
```

La branche de passation est **`main`** : elle contient le Director conversationnel,
l'équipe d'agents IA, les documents H-KIDS, le suivi des plans et l'import des
données réelles. L'ancienne branche `delivery/hkids-clean` a été intégrée à
`main` et n'est plus la branche de référence.

### Installer

```powershell
npm.cmd ci
```

`npm ci` respecte exactement `package-lock.json` et reproduit l'arbre de
dépendances validé.

### Créer `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Pour démarrer, renseigner :

```env
AUTH_MODE="demo"
PORT="3000"
HOST="127.0.0.1"
OPENAI_API_KEY="<la clé de l'entreprise, jamais commitée ni envoyée>"
```

`.env` est ignoré par Git. Ne jamais écrire de vraie clé, de mot de passe ou de
chaîne de connexion dans `.env.example`, le code ou la documentation.

### Démarrer

```powershell
npm.cmd start
```

Ouvrir **<http://127.0.0.1:3000/app/>**. Si le port 3000 est déjà pris,
mettre `PORT="3100"` dans `.env`, redémarrer et ouvrir
<http://127.0.0.1:3100/app/>.

> Utiliser `127.0.0.1` plutôt que `localhost` : sur certains postes, une autre
> application écoute le même port sur toutes les adresses et `localhost` peut
> tomber sur elle.

Sans `OPENAI_API_KEY`, le cockpit fonctionne avec l'ancien Director à mots-clés ;
avec la clé, le message d'accueil indique « Director IA connecté ».

### Utiliser le Director

Le Director est un directeur, pas un assistant : il fixe la stratégie et délègue,
les responsables exécutent. On lui écrit dans le **Briefing** :

| Demande | Ce qui se passe |
| --- | --- |
| « Je veux qu'on fasse 100 000 DH de chiffre d'affaires ce mois » | Le Director **mesure** sur les données ce qui est déjà signé, l'écart, le rythme par jour restant et les devis ouverts ; il **bâtit la stratégie** (part des relances, part des nouvelles affaires, panier visé) et donne à chaque responsable **sa part chiffrée** : Commercial (ventes à signer), Marketing (demandes de devis à générer), Production (capacité de l'atelier), Achats (matières), Finance (encaissements). Chacun répond avec son plan ; le Director fait la synthèse, dit si le total couvre l'écart et liste les **décisions** qui reviennent à la direction (offre, budget, remise…). Le plan et la jauge de l'objectif se suivent dans la vue **Plans**. |
| « Où en est l'objectif du mois ? » | Le Director remesure, donne réalisé / cible / écart / rythme, ce qui a bougé et relance les responsables en retard. |
| « Fais un devis pour Meriem à Marrakech, un lit nuage à 3000 DH » | Le Director confie le devis au **Commercial**, qui le prépare (numéro suivant, TVA, 60/20/20 ; prix sans précision = TTC ; prix absent = catalogue). S'il manque une information, le Director la demande. Carte d'aperçu « préparé par Commercial » → **Valider et générer** → PDF + Word. |
| Bon de commande, bon de livraison, facture | Même principe : Commercial pour le BC et le BL, **Finance** pour la facture, qui doit citer son devis ou son BL. |
| « Combien dois-je encaisser cette semaine ? Prépare les relances » | Le Director délègue à **Finance** (et **Commercial**). Chaque relance devient une **carte WhatsApp** : numéro et texte modifiables, bouton **Envoyer via WhatsApp** qui ouvre WhatsApp pré-rempli. Rien ne part sans le clic d'Hiba. |
| « Qu'est-ce qui risque de bloquer cette semaine ? » | Le Director affiche d'abord un **plan d'action** (objectif, stratégie, priorités, étapes par agent), fait travailler l'équipe, puis signale les **incohérences** entre métiers (production sans acompte, achat avant paiement…). |
| « L'acompte Atlas est arrivé. Où en est le plan ? » | Le Director reprend le plan existant, coche l'étape confirmée, ajoute ce qui est débloqué et donne l'avancement. Les plans se suivent aussi dans la vue **Plans**. |

L'équipe : Commercial, Finance, Production, Achats, Marketing et Community
Manager (le périmètre validé par Hiba), plus RH, SAV et Juridique. Chaque agent ne
lit que ses propres données (§22 du CDC), rédige et propose ; il n'envoie, ne paie
et ne commande jamais rien lui-même.

### Les fichiers de l'entreprise (`data/`)

Le dossier `data/` est **ignoré par Git** : le dépôt est public, ces fichiers ne
doivent jamais y aller.

| Fichier | Rôle | Modèle |
| --- | --- | --- |
| `data/catalogue-hkids.xlsx` | Produits et prix TTC de base : le Commercial s'en sert quand Hiba ne donne pas le prix, et pour bâtir les ventes d'un objectif. Relu à chaque demande, sans redémarrage. | [`docs/catalogue-hkids.xlsx`](docs/catalogue-hkids.xlsx) |
| `data/plans-director.json` | Les plans d'action du Director, créés et mis à jour automatiquement. | — |

Les dossiers réels (clients, devis, commandes, paiements, achats) se chargent dans
la base avec le classeur [`docs/modele-donnees-hkids.xlsx`](docs/modele-donnees-hkids.xlsx) :
voir [Importer les données réelles H-KIDS](#importer-les-données-réelles-h-kids).
Tant qu'ils ne sont pas importés, les agents travaillent sur des **données de
démonstration** et le disent.

### Documents H-KIDS

Toutes les pièces H-KIDS — **devis, bon de commande, facture et bon de livraison** —
sont dessinées par le code, dans le design adopté avec les bons de commande :
logo et adresse du registre (DOUAR HARAKAT N 2153 TASSELTANT SAADA MARRAKECH),
tableau à en-tête vert, totaux sur bandeau vert, conditions de règlement, puis
selon la pièce un bloc « Bon pour accord » ou « Réception de la livraison ».
**Aucun gabarit n'est à fournir.** Les fichiers générés vont dans
`assets/documents/generated/`, ignoré par Git.

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

```powershell
git clone https://github.com/omarelkhaoudi/AI-AGENTS.git
cd AI-AGENTS
npm.cmd ci
```

`npm ci` est recommandé pour reproduire exactement le lockfile de `main`.
Aucune étape de compilation : le projet est en JavaScript ESM natif.

Le design du cockpit est écrit avec **Tailwind CSS** (`src/frontend/tailwind.css`
et les classes de `index.html`). La feuille compilée `src/frontend/styles.css` est
versionnée : rien à compiler pour utiliser le cockpit, et il marche hors ligne.
Après une modification du design, recompiler :

```powershell
npm.cmd run css:build
```

Un test vérifie que `styles.css` correspond bien à la source.

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

Le chemin le plus court : **aucune base de données, aucun compte externe**. Il exige seulement `AUTH_MODE="demo"` pour que le cockpit obtienne automatiquement un jeton.

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

### Importer les données réelles H-KIDS

Les données réelles arrivent par le classeur
[`docs/modele-donnees-hkids.xlsx`](docs/modele-donnees-hkids.xlsx) : Clients,
Devis, Commandes, Paiements, Achats, Fournisseurs. L'entreprise le remplit ;
le fichier rempli contient des données personnelles et **ne se verse jamais
dans le dépôt**.

```bash
npm run data:import-hkids -- --file=C:/chemin/donnees-hkids.xlsx
```

Sans `--write`, la commande vérifie tout et n'écrit rien. Chaque problème est
indiqué par onglet et numéro de ligne (client inconnu, date illisible, valeur
hors liste), et **un seul problème bloque tout l'import**. Une fois le fichier
propre :

```bash
npm run data:import-hkids -- --file=C:/chemin/donnees-hkids.xlsx --write
```

Les enregistrements sont écrits sous la source `future_real_data`, jamais sous
`demo` ; réimporter le même classeur les met à jour sans doublon. Les retards,
priorités et décisions sont calculés **au jour de l'import** : réimportez le
classeur dès qu'il change, et au moins une fois par jour. Une ligne supprimée
du classeur n'est pas supprimée de la base : changez plutôt son statut.

Pour que le Directeur lise ces données au lieu de la démonstration, dans `.env` :

```
BUSINESS_MEMORY_PROVIDER="postgres"
BUSINESS_DATA_PROVIDER="future_real_data"
BUSINESS_PROVIDER_ADAPTER="future_real_data"
BUSINESS_DATA_SOURCE_ID="future_real_data"
```

Les agents Commercial, Finance, Production et Achats lisent alors les données
importées. RH, SAV, Marketing, Community Manager et Juridique n'ont pas encore
d'onglet dans le classeur.

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

`lint`, `build`, `typecheck` et `scan:secrets` : PASS. Clone propre, démarrage serveur, `/health`, `/app/`, Director/Finance et preview H-KIDS avec gabarit DEV : PASS.

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

Le projet génère trois pièces : **facture**, **bon de livraison** et **bon de
commande**, chacune en **PDF et en Word**.

Toutes les pièces H-KIDS — **facture, bon de livraison et bon de commande** — sont
dessinées par le code, dans le design adopté avec les bons de commande et les
devis : logo et coordonnées de la société (adresse du registre, DOUAR HARAKAT N
2153 TASSELTANT SAADA MARRAKECH), titre et objet, tableau à en-tête vert, totaux
sur bandeau vert, conditions de règlement, puis selon la pièce un bloc « Bon pour
accord » (commande) ou « Réception de la livraison » (BL). **Aucun gabarit n'est
à fournir** : seuls le logo du dépôt et une police `.ttf` sont nécessaires.

Trois garanties structurent cette fonctionnalité :

1. **Rien n'est inventé.** Un champ manquant, une valeur ambiguë ou un total qui
   ne tombe pas juste arrête la génération et nomme le problème.
2. **Un aperçu avant tout.** La génération exige un jeton d'aperçu qui
   correspond exactement à ce qui a été relu.
3. **Un numéro de bon de commande n'est jamais attribué deux fois** : la série
   reprend après les bons émis à la main, et un numéro déjà pris est refusé.

Depuis le cockpit : section **Documents H-KIDS**, remplir, **Aperçu**, relire,
puis **Valider et générer**. Les deux fichiers apparaissent en téléchargement.

Les fichiers générés sont écrits dans **`assets/documents/generated/`**, un
répertoire **ignoré par Git** : ces documents portent des données client.

> ⚠️ **La génération PDF exige aussi une police `.ttf` présente sur la machine.**
> Sans configuration, le projet en cherche une aux emplacements habituels de
> Windows, macOS et Linux. S'il n'en trouve aucune, il s'arrête en nommant la
> variable à renseigner — il n'utilise jamais une police de remplacement
> silencieuse. Voir [§14](#14-dépannage).

Variables et messages d'erreur :
[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md), section « Documents H-KIDS ».

---

## 11. OpenAI

Le **Director IA conversationnel** et l'équipe d'agents utilisent OpenAI dès que
`OPENAI_API_KEY` est renseignée. Sans clé, le cockpit garde le Director à
mots-clés et le projet fonctionne entièrement hors ligne.

```text
OPENAI_API_KEY="<la clé de l'entreprise, jamais commitée>"
OPENAI_MODEL="gpt-5"
OPENAI_REASONING_EFFORT="low"
```

- `OPENAI_MODEL` : `gpt-5` par défaut.
- `OPENAI_REASONING_EFFORT` : `minimal`, `low` (défaut), `medium` ou `high`, pour
  les modèles qui raisonnent (GPT-5, série o). `low` ramène une réponse à deux
  agents d'environ 80 s à environ 30 s.
- Temps de réponse constatés : quelques secondes pour un document, 20 à 75 s
  quand plusieurs agents travaillent.

Ce que fait le modèle et ce qu'il ne fait pas :

- il **choisit et remplit des outils** ; l'avancement d'un objectif (réalisé,
  écart, rythme, devis ouverts) est **calculé par le code**
  (`src/agent/sales-objective.js`), jamais estimé par le modèle ; chaque montant est recalculé par le code
  et chaque document passe par la même validation et le même aperçu qu'un
  document saisi à la main ;
- les agents lisent leurs données par `ToolExecutionService` : permissions,
  domaines de sécurité et journal d'audit s'appliquent comme au planificateur ;
- les incohérences entre métiers sont **calculées par le code**
  (`src/agent/consistency.js`), jamais rédigées par le modèle ;
- rien n'est envoyé, payé ni commandé par un agent : messages WhatsApp, documents
  et plans attendent la validation de la direction.

Le code : `src/agent/` (Director, équipe, catalogue, WhatsApp, plans,
cohérence) et les routes `/api/agent/*` et `/api/plans*`.

L'ancien planificateur LLM (`PLANNER_PROVIDER="llm_openai"`) reste disponible
pour l'endpoint `/api/director/requests` ; il est indépendant de l'agent
conversationnel. Détail : [`docs/PLANNER_CONFIGURATION.md`](docs/PLANNER_CONFIGURATION.md).

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
  frontend/         Le cockpit : index.html, app.js, tailwind.css (source) → styles.css (compilé)
  demo/             Donnees de demonstration
  config.js         Lecture de la configuration
  load-dotenv.js    Chargement de .env, sans dependance
  server.js         Point d'entree de npm start

scripts/            Seeds, jetons, lint, build, scan de secrets, ingestion
prisma/             schema.prisma et 6 migrations
test/               La suite complete
docs/               Documentation
assets/documents/   Logo H-KIDS (les pièces sont dessinées par le code).
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
| Director IA conversationnel | ✅ Rôle de directeur : objectif chiffré mesuré sur les données, stratégie, part de chaque responsable, synthèse et décisions ; délègue toute l'exécution |
| Équipe d'agents IA | ✅ 9 agents (dont les 5 + Community Manager du schéma validé), outils et droits propres, testés en réel |
| Plan d'action et suivi | ✅ Plan visible, étapes par agent, échéances, statuts, journal, repris d'un jour à l'autre (vue **Plans**) |
| Cohérence entre métiers | ✅ Contrôles calculés : production sans acompte, achat avant paiement, livré non payé… |
| Documents H-KIDS | ✅ Devis, bon de commande, facture, BL dans le design H-KIDS, PDF + Word, préparés par le Commercial ou la Finance |
| Catalogue | ✅ Lu par le Commercial — **à remplir par l'entreprise** (`data/catalogue-hkids.xlsx`) |
| Messages WhatsApp | 🟡 Rédigés par les agents, envoyés par Hiba depuis WhatsApp (lien `wa.me`) ; pas d'envoi automatique |
| Orchestration, permissions, audit | ✅ Moindre privilège, approbation humaine, journal |
| PostgreSQL | ✅ Migrations versionnées, équivalence mémoire / base vérifiée |
| Interface | ✅ Cockpit : Briefing (conversation), Plans, Validations, Documents, Devis, Dossier, Équipe |
| Données réelles de l'entreprise | 🔴 **En attente** : import prêt (`npm run data:import-hkids`), fichiers à remplir par Hiba |
| Accès en ligne | 🔴 **Non fait** : fonctionne en local ; hébergement et comptes nominatifs à prévoir |
| Voix | 🔴 **Non intégré** |

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

- Tant que le classeur d'Hiba n'est pas importé, les agents travaillent sur des
  **données de démonstration** (« Demo Client Atlas ») et le signalent.
- Une confirmation donnée au Director (« l'acompte est arrivé ») met à jour le
  **plan**, pas encore les **données métier** : elles se mettent à jour par un
  nouvel import du classeur.
- Les conversations avec le Director sont gardées en mémoire du serveur : un
  redémarrage les efface (les plans, eux, sont conservés).
- Le mode `AUTH_MODE="demo"` donne l'accès à quiconque atteint le serveur : il
  convient à un poste local, pas à un accès en ligne.
- Il n'existe ni sauvegarde planifiée ni restauration à un instant donné.

### Prochaines étapes

1. Importer les données réelles et le catalogue d'Hiba.
2. Héberger le système (serveur au nom de l'entreprise) avec un compte par
   personne (Hiba, Hicham, Omar).
3. Faire mettre à jour les données métier par les confirmations données au
   Director, et conserver les conversations.
4. Envoi WhatsApp automatique (WhatsApp Business Platform de Meta, modèles
   approuvés) si le volume le justifie.
5. Sauvegardes planifiées avant toute mise en production.

---

## 📄 Licence

**Aucune licence n'est définie à ce jour.** `package.json` n'en déclare pas et
le dépôt n'en contient aucune. En l'absence de licence explicite, tous les
droits sont réservés par défaut.

La propriété de l'infrastructure — comptes, dépôt, base de données, hébergement
— revient à l'entreprise, conformément au §20 du cahier des charges.
