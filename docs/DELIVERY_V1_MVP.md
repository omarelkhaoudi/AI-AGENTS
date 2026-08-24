# Livraison V1 MVP — AI AGENTS

**Commit de référence : `c2c1d89`** — *feat: add persistent delay alert idempotency*

Ce document décrit ce que contient réellement la V1, ce qu'elle ne contient pas,
et où en est le projet. Tout ce qui y figure est vérifiable dans le code du
commit ci-dessus. Aucune fonctionnalité n'est annoncée comme disponible si elle
ne l'est pas.

---

## 1. Objectif de la V1

Fournir une **équipe d'agents IA d'entreprise fonctionnelle et testable**, où :

- un dirigeant pose une demande en langage naturel ;
- un agent Directeur la décompose et la répartit entre des agents spécialisés ;
- chaque agent ne voit que les données de son propre périmètre ;
- toute action sensible s'arrête devant une validation humaine ;
- tout ce qui se passe laisse une trace.

La V1 est un **socle opérationnel**, pas une maquette : les données transitent
par une vraie base PostgreSQL, la sécurité est appliquée à chaque appel, et un
workflow externe réel (n8n) est connecté de bout en bout.

---

## 2. Les 10 agents

| Agent | Rôle | Périmètre de sécurité |
| --- | --- | --- |
| `director` | Orchestrateur | vue d'ensemble entreprise |
| `commercial` | Devis, clients, relances | devis, clients, commandes |
| `finance` | Encaissements, factures, créances | vue d'ensemble, paiements, clients, factures |
| `production` | Retards et risques de production | production, commandes, notifications externes |
| `purchasing` | Achats et approvisionnement | besoins, fournisseurs, commandes, nomenclatures, stock, produits |
| `hr` | Suivi RH | RH |
| `after_sales` | SAV, réclamations | SAV |
| `marketing` | Campagnes, contenus | marketing |
| `community_manager` | Réseaux sociaux, éditorial | communauté |
| `legal` | Contrats, conformité | juridique |

Chaque agent détient **exactement** les domaines que ses propres outils exigent —
ni plus, ni moins. Cette égalité est vérifiée par la suite de tests à chaque
exécution.

---

## 3. Agent Directeur / Orchestrateur

Le Directeur **n'exécute aucun outil métier lui-même**. Il planifie, délègue,
puis assemble.

Son rapport est structuré en **10 rubriques**, conformes au cahier des charges :

```
CE QUI VA BIEN                RETARDS / PROBLEMES        A ENCAISSER
A COMMANDER                   RISQUES / BLOCAGES         DECISIONS NECESSAIRES
ACTION COMMERCIALE            ACTION MARKETING / COMMUNICATION
INTERVENTION SAV              RISQUE JURIDIQUE
```

Le cycle complet d'une demande est : `Request → Plan → PlanStep → Execution`,
chaque étape étant persistée et auditée.

---

## 4. Outils métier

**21 outils enregistrés par défaut.**

| Type | Nombre | Exemples |
| --- | --- | --- |
| Lecture / analyse | 18 | `get_pending_payments`, `get_production_schedule`, `get_material_requirements` |
| Préparation d'action sensible | 2 | `prepare_hr_sensitive_decision`, `prepare_legal_sensitive_decision` |
| Exécution d'action sensible | 1 | `execute_invoice_payment` |

Un **22ᵉ outil**, `notify_delay_alert`, n'est enregistré que si un client n8n est
injecté au démarrage (voir §10). Sans client, le registre reste strictement
identique à 21 outils.

---

## 5. Business Memory

**15 domaines métier** persistés, chacun dans sa propre table :

```
customers   quotes    invoices    payments    orders
production  purchase_needs        suppliers   hr_demo_overview
after_sales_tickets   products    prices      stock
bills_of_material     payment_terms
```

Deux implémentations interchangeables, choisies par `BUSINESS_MEMORY_PROVIDER` :
**mémoire** (défaut, aucune base requise) ou **PostgreSQL**. L'équivalence entre
les deux est vérifiée domaine par domaine par la suite de tests.

L'accès est contrôlé : un agent qui interroge un domaine hors de son périmètre
est refusé, et le refus est audité sans divulguer le contenu.

---

## 6. Sécurité et permissions

Six niveaux de contrôle, appliqués dans cet ordre :

1. **Bordure** — limitation de débit et taille maximale du corps de requête.
2. **Authentification** — jeton Bearer réel, stocké **haché**, jamais en clair.
3. **Autorisation** — 4 rôles (`viewer`, `operator`, `approver`, `leader`) et 4
   capacités (`read_requests`, `create_requests`, `decide_approvals`,
   `manage_api_tokens`).
4. **Agents autorisés** — chaque outil déclare qui peut l'appeler.
5. **Domaines de sécurité** — un agent doit détenir *tous* les domaines de
   l'outil ; en détenir une partie est un refus, pas une autorisation partielle.
6. **Validation humaine** — voir §7.

Le modèle de permissions comporte 4 types (`read_analyze`, `prepare_action`,
`execute_action`, `human_approval_required`) et 4 décisions possibles
(`execute_directly`, `prepare_only`, `requires_human_approval`, `denied`).

Ce modèle est **gelé par une suite de tests dédiée** : toute modification d'un
périmètre d'agent doit être une édition délibérée de ce fichier, jamais un effet
de bord.

---

## 7. Validation humaine

**Règle appliquée sans exception : tout outil dont la permission n'est pas
`read_analyze` passe obligatoirement par une approbation humaine.**

```
appel outil sensible  ->  APPROVAL_REQUIRED, approbation "pending"
                          rien n est execute
decision humaine      ->  POST /api/approvals/:id/approve   (capacite decide_approvals)
                      ->  l action s execute
```

Garanties vérifiées par tests :

- une approbation ne peut être **décidée** qu'une fois ;
- une approbation ne peut être **dépensée** qu'une fois ;
- ces deux garanties tiennent sous accès concurrent, y compris quand une
  approbation et un rejet se disputent la même décision ;
- un rejet empêche définitivement l'exécution.

---

## 8. Audit

**21 types d'événements** enregistrés, dont : `request_created`,
`request_duplicate_skipped`, `plan_created`, `agent_selected`,
`permission_checked`, `permission_denied`, `tool_called`, `tool_completed`,
`tool_failed`, `approval_requested`, `approval_granted`, `approval_rejected`,
`execution_completed`, `execution_failed`, `authentication_failed`,
`rate_limit_exceeded`.

Les métadonnées sont systématiquement passées par un filtre de masquage avant
d'être écrites : aucun jeton, mot de passe ou secret ne peut atterrir dans la
trace.

---

## 9. Planner et OpenAI

**4 planificateurs disponibles**, sélectionnés par `PLANNER_PROVIDER` :

| Valeur | Comportement |
| --- | --- |
| `deterministic` | **défaut** — routage par mots-clés, aucun appel externe |
| `stub_llm` | planificateur simulé, hors ligne |
| `llm_mock` | fournisseur LLM simulé |
| `llm_openai` | **OpenAI réel**, requiert `OPENAI_API_KEY` |

Le planificateur LLM ne peut **jamais** exécuter d'outil : il produit un plan
structuré, qui est ensuite validé contre le registre réel. Un outil inventé par
un modèle est rejeté.

**En V1, le mode par défaut est `deterministic`** : le système fonctionne
entièrement hors ligne, sans clé OpenAI.

---

## 10. Intégration n8n

Le pont vers n8n est **réel et fonctionnel de bout en bout**, et **désactivé par
défaut**.

```
Agent production
  -> ToolExecutionService     (permissions, domaines, validation d entree)
  -> approbation humaine      obligatoire
  -> notify_delay_alert       adaptateur n8n
  -> webhook n8n reel         HTTP POST authentifie par en-tete
  -> reponse JSON             remontee dans l execution
```

Points de conception :

- l'outil n'est **enregistré que si un client n8n est injecté** au démarrage.
  Avec `WORKFLOW_ENABLED="false"`, aucun client n'existe et aucun appel n'est
  possible ;
- il n'est **pas routable par le planificateur** — le seul point d'entrée est
  `POST /api/production/delay-alerts` ;
- le jeton n8n n'entre jamais dans l'objet de configuration ni dans un message
  d'erreur ;
- l'URL est assainie avant tout journal : d'éventuels identifiants présents dans
  l'URL de base ne peuvent pas fuir.

Le contrat déclare **9 types d'événements workflow**. En V1, **un seul**
(`delay_alert`) dispose d'un outil réel ; les huit autres sont des définitions
contractuelles sans implémentation.

---

## 11. Idempotence

Deux garanties distinctes, toutes deux persistées en base :

**Approbation à usage unique** — une approbation ne peut être décidée qu'une
fois et dépensée qu'une fois, garanti par des écritures conditionnelles
atomiques PostgreSQL.

**Déduplication d'événement métier** — un même événement ne produit qu'une seule
demande. La clé est dérivée ainsi :

```
delay_alert:{orderId}:{delayRisk}:{jour UTC}
```

Règle métier validée : même commande + même niveau de risque + même jour = même
événement. Un changement de niveau de risque constitue un **nouvel** événement.

La garantie est tenue par une **contrainte d'unicité PostgreSQL**, pas par une
vérification applicative : l'insertion de la demande *est* la réservation. Un
doublon est refusé avant qu'un plan, une étape, une approbation ou une exécution
n'existe, et reçoit une réponse `duplicate_skipped` décrivant l'état réel de
l'événement d'origine.

---

## 12. PostgreSQL

- **26 modèles Prisma** : 10 tables d'orchestration, 16 tables métier.
- **6 migrations** appliquées, toutes additives.
- Prisma 7 avec l'adaptateur `pg`.
- Sauvegarde et restauration documentées dans
  [`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md).

Le système démarre **sans PostgreSQL** : sans `DATABASE_URL`, il utilise un
dépôt en mémoire et reste pleinement démontrable.

---

## 13. Cockpit

Une interface web est servie par l'API :

| Route | Contenu |
| --- | --- |
| `/` et `/app/` | cockpit dirigeant |
| `/api/director/requests` | demande au Directeur, réponse structurée en 10 rubriques |
| `/api/approvals` | approbations en attente |
| `/api/approvals/:id/approve` · `/reject` | décision humaine |

---

## 14. SOP

**9 procédures opératoires** sont définies, une par agent spécialisé
(commercial, finance, production, achats, SAV, RH, marketing, community manager,
juridique).

**Toutes sont au statut `draft`** et ne sont **pas exposées par l'API** en V1.
Elles constituent une base structurée, pas une fonctionnalité utilisable.

---

## 15. État des tests

```
Commit    : c2c1d89
Fichiers  : 65
Tests     : 723
Reussis   : 723
Echecs    : 0
Ignores   : 0
Duree     : 36,5 s (avec PostgreSQL)
```

Détail complet dans [`V1_TEST_REPORT.md`](V1_TEST_REPORT.md).

---

## 16. Limites et hors périmètre V1

Ces points sont **connus et assumés**. Ils ne sont pas des défauts cachés.

**Le workflow n8n n'envoie aucune notification à un humain.** Le pont technique
est complet et prouvé, mais le workflow `delay-alert` se limite aujourd'hui à
accuser réception. Le choix du canal (courriel, messagerie, autre) n'a pas été
arbitré et relève de la phase suivante.

**Huit des neuf événements workflow n'ont pas d'outil.** Seul `delay_alert` est
implémenté.

**Le compte n8n est un essai personnel.** Le cahier des charges exige une
propriété d'entreprise ; ce point doit être réglé avant toute mise en
production.

**Si n8n est injoignable, l'alerte est perdue pour la journée.** L'approbation
est dépensée avant l'appel et la clé d'idempotence est prise. La règle de
reprise n'a pas encore été arbitrée.

**Les données métier sont des données de démonstration** par défaut. Un
connecteur de données réelles existe comme frontière, sans implémentation.

**Les agrégats de chiffre d'affaires et de ventes ne sont produits par aucun
outil.**

**Les commandes vocales ne sont pas implémentées.**

**Les SOP ne sont pas exposées par l'API.**

**Les détails d'erreur des adaptateurs sont appauvris** au passage du registre
d'outils : seul un code générique remonte à l'appelant. Le diagnostic fin
nécessite les journaux du serveur.

**Aucune sauvegarde planifiée ni copie hors site** n'est en place ; la procédure
manuelle est documentée.

---

## 17. Prochaines étapes prévues

1. **Décider du canal de notification** derrière le workflow n8n, puis
   l'implémenter.
2. **Régler la propriété du compte n8n** (instance d'entreprise).
3. **Arbitrer la règle de reprise** en cas d'échec d'appel n8n.
4. **Compléter les agrégats métier** manquants (chiffre d'affaires, ventes).
5. **Enrichir le cockpit** et connecter documents et messagerie.
6. **Commandes vocales**, après validation du noyau.
7. **Audit final de conformité** au cahier des charges.
8. **Déploiement** : sauvegardes planifiées, copie hors site.

---

## Documents liés

| Document | Contenu |
| --- | --- |
| [`V1_INSTALLATION_GUIDE.md`](V1_INSTALLATION_GUIDE.md) | Installer et démarrer |
| [`V1_DEMO_GUIDE.md`](V1_DEMO_GUIDE.md) | Scénarios de démonstration |
| [`V1_TEST_REPORT.md`](V1_TEST_REPORT.md) | Rapport de tests |
| [`AGENTS.md`](AGENTS.md) | Les agents en détail |
| [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md) | Le schéma de base |
| [`AI_AGENTS_FOUNDATION_ARCHITECTURE.md`](AI_AGENTS_FOUNDATION_ARCHITECTURE.md) | Architecture technique |
