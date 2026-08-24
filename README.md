# AI AGENTS

Système d'exploitation intelligent de l'entreprise, organisé autour d'un **Agent
Directeur** qui comprend une demande, la planifie, sollicite les agents
spécialisés, lit les données métier et produit une synthèse exploitable.

Le point d'entrée du dirigeant est unique : une question en langage naturel.

> **« Fais-moi le point sur mon entreprise aujourd'hui. »**

Le Directeur planifie treize étapes réparties sur neuf agents, exécute les
outils correspondants, déduplique les signaux et rend un rapport en dix
rubriques.

---

## 🎯 Vision

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

---

## 🏗️ Architecture

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
Tools (21)                       une capacité vérifiable, autorisée
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
| **Stockage** | PostgreSQL via Prisma, ou une implémentation en mémoire pour le développement et les tests. Les deux renvoient des enregistrements identiques. |

Le planificateur par défaut est **déterministe** : il sélectionne les agents en
analysant la formulation de la demande et leur assigne une liste d'outils fixe.
Aucun modèle de langage n'est sollicité dans cette configuration. Un
planificateur LLM existe derrière la même interface — voir
[`docs/PLANNER_CONFIGURATION.md`](docs/PLANNER_CONFIGURATION.md).

---

## 🤖 Les 10 agents

Le Directeur supervise huit agents directement. Le Community Manager rend compte
au Marketing, pas au Directeur.

| Agent | Mission | Informations accessibles | Outils |
| --- | --- | --- | --- |
| **Director** | Comprendre la demande, construire un plan sûr, déléguer, consolider | contexte de requête, catalogues d'agents et d'outils, statut d'exécution | `get_company_overview` |
| **Commercial** | Identifier les priorités commerciales, relances de devis et actions client | clients, devis, commandes, pipeline | `get_pending_quotes`, `get_quote_follow_ups`, `get_customer_overview`, `get_customer_orders` |
| **Finance** | Analyser créances, priorités d'encaissement et signaux administratifs | paiements, créances, factures, clients | `get_pending_payments`, `get_receivables_summary`, `get_overdue_invoices`, `get_customer_overview`, `get_company_overview`, `execute_invoice_payment` |
| **Production** | Identifier les commandes en retard ou à risque | commandes, production, risques de livraison, capacité | `get_delayed_production_orders`, `get_production_schedule`, `get_customer_orders` |
| **Purchasing** | Identifier les besoins d'achat et préparer les recommandations | besoins d'achat, fournisseurs, commandes, stock | `get_purchase_needs`, `get_material_requirements`, `get_supplier_catalog` |
| **HR** | Analyser administration RH, absences, contrats, incidents, besoins en personnel | signaux RH de démonstration uniquement | `get_hr_overview`, `prepare_hr_sensitive_decision` |
| **After Sales** | Centraliser réclamations, garantie, interventions et satisfaction | tickets SAV, clients, commandes | `get_after_sales_overview` |
| **Marketing** | Analyser priorités marketing, campagnes et besoins de contenu | campagnes, contenus, performance, calendrier éditorial | `get_marketing_overview` |
| **Community Manager** | Préparer les priorités communautaires et éditoriales pour le Marketing | contenus publics, calendrier, commentaires, messages | `get_community_overview` |
| **Legal** | Identifier risques contractuels, clauses, échéances et dossiers à valider | contrats, documents juridiques, clauses, litiges | `get_legal_overview`, `prepare_legal_sensitive_decision` |

**Actions autorisées.** Les dix agents peuvent analyser (`read_analyze`) et
préparer une action (`prepare_action`). Aucun ne peut exécuter une action
sensible seul : Finance, HR et Legal préparent, un humain décide.

Détail complet des rôles, permissions et domaines de sécurité :
[`docs/AGENTS.md`](docs/AGENTS.md).

---

## 🛠️ Tools

Vingt et un outils sont enregistrés. Un outil déclare ses agents autorisés, la
permission qu'il exige et les domaines métier qu'il lit.

| Catégorie | Outils |
| --- | --- |
| Vue d'ensemble | `get_company_overview` |
| Finance | `get_pending_payments`, `get_receivables_summary`, `get_overdue_invoices`, `execute_invoice_payment` |
| Commercial | `get_pending_quotes`, `get_quote_follow_ups` |
| Production | `get_delayed_production_orders`, `get_production_schedule` |
| Achats | `get_purchase_needs`, `get_material_requirements`, `get_supplier_catalog` |
| RH | `get_hr_overview`, `prepare_hr_sensitive_decision` |
| SAV | `get_after_sales_overview` |
| Marketing | `get_marketing_overview` |
| Community | `get_community_overview` |
| Juridique | `get_legal_overview`, `prepare_legal_sensitive_decision` |
| Clients | `get_customer_overview` |
| Commandes | `get_customer_orders` |

Deux familles se distinguent : les outils **de lecture**, qui restituent des
enregistrements, et les outils **de calcul**, qui dérivent une information
absente des données brutes — un total de créances par devise, un manque de
matière calculé depuis la nomenclature et le stock, l'état réel d'une commande
au regard de son échéance.

**Seize des vingt et un outils sont routés** par le planificateur déterministe.
Les cinq autres sont enregistrés et autorisés, mais atteignables uniquement via
le service d'exécution, pas via une demande au Directeur.

---

## 🧠 Business Memory

La mémoire métier est le contrat unique par lequel un outil lit des données. Un
outil demande un domaine ; il ignore où et comment il est stocké.

**Quinze domaines** : `customers`, `quotes`, `invoices`, `payments`, `orders`,
`production`, `purchase_needs`, `suppliers`, `hr_demo_overview`,
`after_sales_tickets`, `products`, `prices`, `stock`, `bills_of_material`,
`payment_terms`.

Chaque enregistrement porte la même enveloppe : un identifiant métier, une
**source** (`demo_mock` ou `future_real_data`), un statut, une charge utile
métier, des relations et des dates typées, et un rang qui fixe son ordre dans
son domaine.

**Deux axes indépendants** pilotent la lecture :

| Variable | Valeurs | Question |
| --- | --- | --- |
| `BUSINESS_MEMORY_PROVIDER` | `memory`, `postgres` | Où les enregistrements sont stockés |
| `BUSINESS_DATA_PROVIDER` | `demo`, `future_real_data` | D'où ils proviennent |

**Équivalence Memory ↔ PostgreSQL.** Les deux implémentations renvoient des
enregistrements identiques sur les quinze domaines, et le Directeur produit le
même rapport à travers l'une ou l'autre. C'est vérifié automatiquement, pas
supposé.

**Il n'y a pas de mémoire vectorielle ni de RAG.** La mémoire métier est
structurée et relationnelle. Aucune recherche sémantique n'est utilisée.

---

## 🗄️ Base de données

PostgreSQL via **Prisma 7**, avec l'adaptateur `@prisma/adapter-pg`.

| | |
| --- | --- |
| Modèles Prisma | **26** |
| Migrations versionnées | **5** |
| Domaines métier | **15** |

Dix tables portent l'orchestration — requêtes, plans, étapes, exécutions,
approbations, audit — et seize portent la mémoire métier. Un agent n'atteint
jamais les tables d'orchestration ; l'orchestration ne porte aucun contenu
métier.

Détail des modèles, correspondances domaine → modèle et migrations :
[`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md).

---

## 🎯 Director — rapport dirigeant

À la question « Fais-moi le point sur mon entreprise aujourd'hui », le Directeur
répond en **dix rubriques**, conformément au §31 du cahier des charges :

| Rubrique | Ce qu'elle porte |
| --- | --- |
| **CE QUI VA BIEN** | Commandes à l'heure, signaux positifs |
| **RETARDS / PROBLEMES** | Commandes en danger ou en retard, réclamations qualité |
| **A ENCAISSER** | Créances, montant et devise, ancienneté du retard |
| **A COMMANDER** | Manques de matière et besoins d'achat |
| **RISQUES / BLOCAGES** | Ce qui menace un engagement |
| **DECISIONS NECESSAIRES** | Ce qui attend un arbitrage du dirigeant |
| **CE QUI NECESSITE UNE ACTION COMMERCIALE** | Devis sans réponse, relances |
| **CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION** | Campagnes et contenus |
| **CE QUI NECESSITE UNE INTERVENTION SAV** | Dossiers après-vente ouverts |
| **CE QUI PRESENTE UN RISQUE JURIDIQUE** | Contrats, clauses, échéances |

Chaque entrée est rédigée pour être lue, pas décodée :

```
A ENCAISSER
  Demo Client Atlas - 12000 MAD - en retard de 2 jour(s)
  Demo Client Nova - 8500 MAD - echeance aujourd'hui

RETARDS / PROBLEMES
  Demo Client Atlas - en danger - Demo missing aluminum material
```

Les quatre états de production du CDC sont distingués et dirigés vers des
rubriques différentes : **à l'heure** vers ce qui va bien, **à surveiller** vers
les risques, **en danger** et **en retard** vers les retards. Le retard est
mesuré contre l'horloge réelle.

Un même signal remonté par deux outils n'est compté qu'une fois.

---

## 🔐 Sécurité et validation humaine

**Authentification.** Chaque appel API exige un jeton porteur. Seul le
condensat du jeton est stocké, jamais le secret. Les jetons se créent avec
`npm run auth:create-token`.

**Moindre privilège.** Un agent détient exactement les domaines de sécurité que
ses propres outils exigent — ni plus, ni moins. Ce modèle est figé par un test :
l'élargir suppose une modification délibérée du fichier de permissions.

**Quatre contrôles indépendants** avant qu'un outil s'exécute :

1. l'outil nomme les agents autorisés à l'appeler ;
2. l'agent détient la permission requise (`read_analyze`, `prepare_action`, `execute_action`) ;
3. l'agent détient **tous** les domaines de sécurité que l'outil lit ;
4. une action sensible s'arrête et attend une décision humaine.

**Trois niveaux de validation**, conformément au §17 du CDC :

| Niveau | Exemples | Comportement |
| --- | --- | --- |
| 1 — Autonome | analyser, classer, calculer, préparer une synthèse | L'agent agit seul |
| 2 — Sous règles | actions conditionnées par des règles définies | Encadré par les permissions |
| 3 — Validation obligatoire | paiement, décision RH sensible, engagement juridique | L'agent **prépare**, un humain autorise |

Trois outils relèvent du niveau 3 : `execute_invoice_payment`,
`prepare_hr_sensitive_decision`, `prepare_legal_sensitive_decision`. Ils ne
s'exécutent jamais seuls.

**Audit.** Vingt et un types d'événements tracent la vie d'une requête :
création, plan, étapes, vérifications de permission, appels d'outils,
approbations, exécutions terminées ou bloquées. Une étape qui échoue enregistre
la cause de façon structurée, sans jamais exposer un message d'erreur brut.

**Limitation de débit** en amont de l'authentification, et taille de corps de
requête bornée.

---

## 🧪 Tests et qualité

| Contrôle | Résultat vérifié |
| --- | --- |
| `npm test` avec PostgreSQL | **618 tests · 618 passés · 0 échec · 0 ignoré** |
| `npm test` sans PostgreSQL | 618 tests · 605 passés · 0 échec · 13 ignorés |
| `npm run lint` | ✅ |
| `npm run build` | ✅ |
| `npm run scan:secrets` | ✅ aucun secret en dur |

La suite fonctionne **hors ligne** : sans base de données, les treize tests
d'intégration PostgreSQL se déclarent ignorés et le reste passe.

Trois familles méritent d'être signalées :

- **Tests d'équivalence Memory ↔ PostgreSQL** — le même rapport doit sortir des
  deux implémentations, rubrique par rubrique, libellé par libellé.
- **Tests structurels de documentation** — la suite échoue si un agent, un
  outil, un domaine, un modèle ou une migration est ajouté sans être documenté,
  ou si une documentation affirme quelque chose que le code contredit.
- **Tests de non-dérive des permissions** — un instantané figé du modèle de
  moindre privilège, qui échoue à tout élargissement non délibéré.

---

## 📦 V1 MVP

La V1 MVP fonctionnelle et testable est figée au commit **`c2c1d89`** :
**723 tests, 723 réussis, 0 échec, 0 ignoré**.

| Document | Contenu |
| --- | --- |
| [`docs/DELIVERY_V1_MVP.md`](docs/DELIVERY_V1_MVP.md) | Périmètre livré, limites assumées, prochaines étapes |
| [`docs/V1_INSTALLATION_GUIDE.md`](docs/V1_INSTALLATION_GUIDE.md) | Prérequis, installation, configuration, démarrage |
| [`docs/V1_DEMO_GUIDE.md`](docs/V1_DEMO_GUIDE.md) | Dix scénarios de démonstration reproductibles |
| [`docs/V1_TEST_REPORT.md`](docs/V1_TEST_REPORT.md) | Rapport de tests détaillé |

---

## 📚 Documentation

| Document | Contenu |
| --- | --- |
| [`docs/AGENTS.md`](docs/AGENTS.md) | Les dix agents, leurs outils, permissions et domaines de sécurité |
| [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) | Les 26 modèles, les 15 domaines, les migrations |
| [`docs/BACKUP_AND_RESTORE.md`](docs/BACKUP_AND_RESTORE.md) | Sauvegarde, restauration, reprise du projet |
| [`docs/POSTGRESQL_SETUP.md`](docs/POSTGRESQL_SETUP.md) | Installation de la base, Docker ou local |
| [`docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md`](docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md) | Architecture technique détaillée |
| [`docs/PLANNER_CONFIGURATION.md`](docs/PLANNER_CONFIGURATION.md) | Choix du planificateur |
| [`docs/AGENT-MVP-BOUNDARIES.md`](docs/AGENT-MVP-BOUNDARIES.md) | Frontières du MVP |

---

## 🚀 Installation

Node.js **20 ou supérieur** est requis.

```bash
git clone https://github.com/omarelkhaoudi/AI-AGENTS.git
cd AI-AGENTS
npm install
```

À ce stade, l'application fonctionne déjà : le fournisseur de mémoire par défaut
est `memory` et ne nécessite aucune base de données.

### Avec PostgreSQL

Un `docker-compose.yml` est fourni, exposant PostgreSQL sur le port **5433**
pour éviter un conflit avec une instance déjà présente sur 5432.

```bash
docker compose up -d db
```

Créez ensuite un fichier `.env` à partir de `.env.example`, renseignez
`DATABASE_URL`, puis :

```bash
npm run db:generate      # génère le client Prisma
npm run db:migrate       # applique les 5 migrations
npm run db:seed          # sème les 10 agents et leurs permissions
```

Optionnel — pour disposer de données métier de démonstration :

```bash
npm run db:seed:business -- --apply
```

Ces commandes sont idempotentes. Procédure complète, y compris sans Docker :
[`docs/POSTGRESQL_SETUP.md`](docs/POSTGRESQL_SETUP.md).

---

## ⚙️ Configuration

Toute la configuration passe par des variables d'environnement.
`.env.example` est la référence versionnée ; **il ne contient aucune valeur
réelle**. Le fichier `.env` est ignoré par Git et ne doit jamais être commité.

| Variable | Rôle |
| --- | --- |
| `DATABASE_URL` | Chaîne de connexion PostgreSQL |
| `BUSINESS_MEMORY_PROVIDER` | `memory` (défaut) ou `postgres` |
| `BUSINESS_DATA_PROVIDER` | `demo` (défaut) ou `future_real_data` |
| `PLANNER_PROVIDER` | `deterministic` (défaut), `stub_llm`, `llm_mock`, `llm_openai` |
| `AUTH_MODE` | `token` (défaut) ou `demo` — `demo` est refusé en production |
| `API_BODY_LIMIT_BYTES` | Taille maximale d'un corps de requête |
| `RATE_LIMIT_READ_MAX` / `WRITE_MAX` / `DECISION_MAX` | Limitation de débit |
| `WORKFLOW_PROVIDER`, `WORKFLOW_ENABLED` | Frontière n8n, désactivée |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Utilisés uniquement si `PLANNER_PROVIDER="llm_openai"` |
| `RUN_POSTGRES_INTEGRATION` | Active les tests d'intégration PostgreSQL |

**Prisma 7 ne lit plus `.env` automatiquement.** Les commandes `db:generate` et
`db:migrate` résolvent leur configuration depuis l'environnement du processus :
exportez `DATABASE_URL` avant de les lancer.

---

## ▶️ Lancement

```bash
npm start                # démarre l'API sur 127.0.0.1:3000
npm test                 # lance la suite complète
npm run lint             # vérification de style
npm run build            # validation de build
npm run scan:secrets     # recherche de secrets en dur
npm run typecheck        # vérification de types
```

Le port et l'hôte se règlent par `PORT` et `HOST`.

Une fois l'API démarrée, le cockpit est servi sur `/app/` et un point de santé
sur `/health`. La demande au Directeur passe par
`POST /api/director/requests` avec un corps `{ "message": "..." }`.

Commandes liées à la base :

```bash
npm run db:validate            # valide le schéma Prisma
npm run db:generate            # génère le client
npm run db:migrate             # applique les migrations
npm run db:seed                # sème les agents
npm run db:seed:business -- --apply   # sème les données de démonstration
npm run auth:create-token      # crée un jeton d'API
npm run data:ingest            # ingère des enregistrements métier
```

Pour exécuter les treize tests d'intégration PostgreSQL, exportez
`RUN_POSTGRES_INTEGRATION=true` et un `DATABASE_URL` valide avant `npm test`.

---

## 🔄 État actuel du projet

| Domaine | État |
| --- | --- |
| Orchestration | ✅ Implémenté — plan validé, exécution étape par étape, consolidation |
| Les 10 agents | ✅ Implémenté — missions, permissions et outils réels |
| Tools | ✅ 21 enregistrés · 16 routés par le planificateur |
| Business Memory | ✅ Implémenté — 15 domaines, contrat unique |
| PostgreSQL | ✅ Implémenté — 26 modèles, 5 migrations, équivalence vérifiée |
| Sécurité | ✅ Implémenté — authentification, moindre privilège, domaines |
| Validation humaine | ✅ Implémenté — 3 niveaux, 3 outils sensibles |
| Audit | ✅ Implémenté — 21 types d'événements, causes structurées |
| Director §31 | ✅ Implémenté — les 10 rubriques |
| Documentation | ✅ Implémenté — vérifiée par tests structurels |
| Interface | 🟡 Partiel — cockpit fonctionnel, volontairement minimal |
| Planificateur LLM | 🟡 Partiel — implémenté derrière une interface, désactivé par défaut |
| **n8n / workflows** | 🔴 **Non intégré** — frontière contractuelle uniquement, `WORKFLOW_ENABLED="false"`, toute invocation lève une erreur |
| **Voix** | 🔴 **Non intégré** — emplacement réservé dans le cockpit, `status: "prepared_offline"`, `enabled: false` |
| Connexions externes | 🔴 Aucune — aucun appel sortant n'est activé |

Les frontières n8n et voix existent en tant que **contrats typés et testés**,
pas en tant que fonctionnalités. Aucune donnée ne sort du système aujourd'hui.

---

## 🗺️ Roadmap

1. **Compléter les éléments métier restants du CDC** — notamment les agrégats du
   §29 (chiffre d'affaires, ventes), qu'aucun outil ne produit encore.
2. **Intégrer les workflows n8n réels** — prochaine phase. Dépend d'une décision
   d'infrastructure : instance, propriété des comptes, accès.
3. **Interface et intégrations restantes** — enrichir le cockpit, connecter
   documents et messagerie.
4. **Commandes vocales** — après validation du noyau, conformément à la
   priorisation du CDC.
5. **Audit final de conformité au CDC**.
6. **Déploiement en production** — sauvegardes planifiées, copie hors site,
   supervision.

Deux dettes techniques sont identifiées et documentées : le rang des
enregistrements est stocké dans un champ JSON plutôt que dans une colonne
indexée, et il n'existe ni sauvegarde planifiée ni récupération à un instant
donné.

---

## 💾 Backup & Restore

La base de données est la seule partie irremplaçable du système : le code est
dans Git, la configuration se recrée depuis `.env.example`, les agents et les
données de démonstration se resèment.

```bash
pg_dump -h localhost -p 5432 -U postgres -d ai_agents -Fc -f ai_agents.dump
```

Une sauvegarde ne vaut que ce que vaut sa restauration. La procédure de
vérification — restaurer dans une base séparée et comparer les comptes — est
décrite dans [`docs/BACKUP_AND_RESTORE.md`](docs/BACKUP_AND_RESTORE.md), avec la
reconstruction complète et la passation à un autre développeur.

---

## 📌 Principes du projet

- **Architecture modulaire** — aucune couche ne connaît l'implémentation de la suivante.
- **Séparation Director / Agents / Tools / Memory** — une responsabilité par couche.
- **Moindre privilège** — un agent détient exactement ce que ses outils exigent.
- **Validation humaine des actions sensibles** — l'agent prépare, l'humain décide.
- **Traçabilité** — toute action importante laisse une trace exploitable.
- **Les données métier sont la source de vérité** — pas l'historique de conversation.
- **Tests avant livraison** — une correction sans test qui la verrouille n'est pas terminée.
- **Ajouter avant de remplacer** — un outil existant n'est retiré qu'une fois son remplaçant validé.

---

## 📄 Licence

**Aucune licence n'est définie à ce jour.** Le fichier `package.json` ne
déclare pas de licence et le dépôt n'en contient aucune. En l'absence de
licence explicite, tous les droits sont réservés par défaut.

La propriété de l'infrastructure — comptes, dépôt, base de données, hébergement
— revient à l'entreprise, conformément au §20 du cahier des charges.
