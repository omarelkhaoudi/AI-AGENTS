# Guide de démonstration — V1 MVP

> ⚠️ **Instantané historique.** Ces scénarios ont été vérifiés contre le
> planificateur au commit `c2c1d89`. Ils restent globalement valides, mais des
> outils ont été ajoutés depuis et le rapport peut contenir davantage de
> lignes. Pour démarrer une démonstration aujourd'hui, voir le
> [README](../README.md), section « Démarrage rapide — Demo ».

**Commit de référence : `c2c1d89`**

Dix scénarios reproductibles, du plus simple au plus complet. Chaque demande
ci-dessous a été **vérifiée contre le planificateur réel** : elle produit bien
les agents et les outils annoncés.

---

## Préparation

1. Suivre [`V1_INSTALLATION_GUIDE.md`](V1_INSTALLATION_GUIDE.md).
2. Démarrer l'application :

```bash
npm start
```

3. Obtenir un jeton et le placer dans une variable de shell :

```bash
curl -s http://127.0.0.1:3000/api/auth/demo-session
```

Dans les exemples, `$TOKEN` désigne ce jeton.

Les scénarios **1 à 8** fonctionnent **sans base de données et sans n8n**. Les
scénarios **9 et 10** exigent le pont n8n activé.

### Deux façons de démontrer

**Par le cockpit** — ouvrir `http://127.0.0.1:3000/`, saisir la demande, lire le
rapport en 10 rubriques. C'est le mode conseillé face à un dirigeant.

**Par l'API** — commande `curl`, réponse JSON complète. Utile pour montrer la
traçabilité.

Modèle d'appel utilisé partout :

```bash
curl -s -X POST http://127.0.0.1:3000/api/director/requests -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"message":"VOTRE DEMANDE ICI"}'
```

---

## Scénario 1 — Vue globale de l'entreprise

**Demande** — *« Fais le point complet sur l'entreprise. »*

**Agents mobilisés** — finance, commercial, production, achats, SAV

**Résultat attendu**

Le Directeur produit un plan de 9 étapes et assemble un rapport unique réparti
dans les 10 rubriques : `CE QUI VA BIEN`, `RETARDS / PROBLÈMES`, `À ENCAISSER`,
`À COMMANDER`, `RISQUES / BLOCAGES`, `DÉCISIONS NÉCESSAIRES`, et les rubriques
d'action commerciale, marketing, SAV et juridique.

**Ce qu'il faut montrer** — un seul message en langage naturel déclenche cinq
agents, chacun restant dans son périmètre, et le dirigeant reçoit une synthèse
et non cinq rapports.

**Validation humaine** — aucune. Toutes les étapes sont en lecture seule.

---

## Scénario 2 — Finance

**Demande** — *« Où en sommes-nous sur la trésorerie et les factures impayées ? »*

**Agent** — finance

**Outils** — `get_pending_payments`, `get_receivables_summary`

**Résultat attendu** — les paiements en attente et un résumé des créances,
ventilé par devise. La rubrique `À ENCAISSER` est renseignée.

**Validation humaine** — aucune.

---

## Scénario 3 — Commercial

**Demande** — *« Quels devis clients faut-il relancer ? »*

**Agent** — commercial

**Outils** — `get_pending_quotes`, `get_quote_follow_ups`

**Résultat attendu** — les devis en attente et ceux dont la relance est due,
calculée par rapport à la date du jour. La rubrique `ACTION COMMERCIALE` est
renseignée.

**Validation humaine** — aucune.

---

## Scénario 4 — Production

**Demande** — *« Quelles commandes de production sont en retard ? »*

**Agent** — production

**Outils** — `get_delayed_production_orders`, `get_production_schedule`

**Résultat attendu** — les ordres de production classés selon les **quatre états
du cahier des charges** : `ON_TIME`, `AT_RISK`, `IN_DANGER`, `LATE`. Ce qui est à
l'heure va dans `CE QUI VA BIEN`, le reste dans `RETARDS / PROBLÈMES`.

**Point à souligner** — le retard est mesuré **contre l'horloge réelle**, pas
contre une date figée dans les données de démonstration.

**Validation humaine** — aucune.

---

## Scénario 5 — Achats

**Demande** — *« Qu'est-ce qu'il faut commander chez les fournisseurs ? »*

**Agent** — achats

**Outils** — `get_purchase_needs`, `get_material_requirements`

**Résultat attendu** — les besoins d'achat, et les manques de matière déduits
des commandes ouvertes, de leur nomenclature et du stock disponible. Seul le
stock explicitement disponible est compté ; ce qui ne peut pas être déduit est
signalé comme anomalie plutôt que deviné. La rubrique `À COMMANDER` est
renseignée.

**Validation humaine** — aucune.

---

## Scénario 6 — Demande multi-agents

**Demande** — *« Fais le point sur les paiements en attente et les commandes de
production en retard. »*

**Agents** — finance **et** production

**Outils** — `get_pending_payments`, `get_receivables_summary`,
`get_delayed_production_orders`, `get_production_schedule`

**Résultat attendu** — un plan de 4 étapes, deux agents mobilisés en parallèle,
un rapport unique. Chaque résultat porte le nom de l'agent qui l'a produit.

**Ce qu'il faut montrer** — la répartition est déduite de la formulation, sans
que le dirigeant ait à désigner les agents.

**Validation humaine** — aucune.

---

## Scénario 7 — Action sensible : paiement

**Demande** — *« Effectue le paiement de cette facture. »*

**Agent** — finance · **Outil** — `execute_invoice_payment`

**Résultat attendu — le point le plus important de la démonstration**

**Rien n'est exécuté.** La réponse porte le statut `requires_approval`, l'étape
est `not_executed`, et une approbation apparaît à l'état `pending`.

**Validation humaine — obligatoire**

Lister les approbations en attente :

```bash
curl -s http://127.0.0.1:3000/api/approvals -H "Authorization: Bearer $TOKEN"
```

Puis décider :

```bash
curl -s -X POST http://127.0.0.1:3000/api/approvals/<ID>/approve -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"decisionReason":"Validé en démonstration."}'
```

L'action ne s'exécute **qu'après** cette décision.

**À montrer aussi** — le refus. `POST /api/approvals/<ID>/reject` empêche
définitivement l'exécution. Et une approbation déjà utilisée ne peut pas être
rejouée : une seconde tentative répond `409 APPROVAL_ALREADY_EXECUTED`.

---

## Scénario 8 — Action sensible : RH et juridique

**Demande RH** — *« Prépare une décision RH sensible de licenciement. »*
→ agent RH, outil `prepare_hr_sensitive_decision`

**Demande juridique** — *« Il faut signer ce contrat fournisseur. »*
→ agent juridique, outil `prepare_legal_sensitive_decision`

**Résultat attendu** — même comportement qu'au scénario 7 : l'agent **prépare**,
il ne décide pas. Approbation `pending`, aucune exécution.

**Ce qu'il faut montrer** — la règle est générale, pas particulière à la finance :
**tout outil qui n'est pas en lecture seule passe par un humain.**

**Validation humaine** — obligatoire.

---

## Scénario 9 — Alerte de retard vers n8n

> **Prérequis** — pont n8n activé (§8 du guide d'installation). Sans cela, la
> route répond `409 WORKFLOW_NOT_ENABLED`, ce qui constitue déjà une
> démonstration valable du garde-fou.

**Étape 1 — lever l'alerte**

```bash
curl -s -X POST http://127.0.0.1:3000/api/production/delay-alerts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"orderId":"order-atlas-001","delayRisk":"high"}'
```

**Résultat attendu** — `202` avec `status: "approval_required"` et une
approbation `pending`. **Rien n'est envoyé à n8n à ce stade.**

**Étape 2 — approuver**

```bash
curl -s -X POST http://127.0.0.1:3000/api/approvals/<ID>/approve -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"decisionReason":"Confirmé avec l atelier."}'
```

**Résultat attendu** — `200`, exécution `completed`, `httpStatus: 200` et le
corps renvoyé par n8n. **C'est à cet instant, et pas avant, que l'appel externe
part.**

**Étape 3 — vérifier côté n8n**

Onglet **Executions** du workflow : une nouvelle exécution réussie, portant
l'événement complet (`type`, `correlationId`, `agentId`, `payload.orderId`,
`payload.delayRisk`).

**Ce qu'il faut montrer** — une donnée métier ne quitte l'entreprise qu'après une
décision humaine explicite, et l'appel externe est corrélé à l'exécution qui l'a
produit.

**Limite à annoncer honnêtement** — le workflow n8n accuse réception ; il
n'envoie encore de notification à personne. Le choix du canal relève de la phase
suivante.

---

## Scénario 10 — Déduplication d'événement

> **Prérequis** — mêmes que le scénario 9.

**Rejouer exactement la même commande qu'à l'étape 1 du scénario 9 :**

```bash
curl -s -X POST http://127.0.0.1:3000/api/production/delay-alerts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"orderId":"order-atlas-001","delayRisk":"high"}'
```

**Résultat attendu** — `200` avec :

```json
{
  "status": "duplicate_skipped",
  "idempotencyKey": "delay_alert:order-atlas-001:high:<jour UTC>",
  "duplicateOf": "<id de la demande d origine>",
  "approval": { "status": "approved" },
  "execution": { "status": "completed" }
}
```

**Aucune nouvelle demande, aucune nouvelle approbation, aucun nouvel appel n8n.**

**Variante à montrer** — changer le niveau de risque :

```bash
curl -s -X POST http://127.0.0.1:3000/api/production/delay-alerts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"orderId":"order-atlas-001","delayRisk":"critical"}'
```

Cette fois, `202` : un risque qui change est un **nouvel événement métier**, qui
mérite sa propre décision humaine.

**Ce qu'il faut montrer** — la règle « même commande + même risque + même jour =
même alerte » est tenue par la base de données, pas par une vérification
applicative. Elle résiste donc aux appels simultanés.

---

## Consulter la trace

Après n'importe quel scénario :

```bash
curl -s http://127.0.0.1:3000/api/requests/<REQUEST_ID> -H "Authorization: Bearer $TOKEN"
```

La réponse contient le plan, ses étapes, les exécutions, les approbations et
**tous les événements d'audit** : `request_created`, `plan_created`,
`agent_selected`, `permission_checked`, `tool_called`, `tool_completed`,
`approval_requested`, `approval_granted`, `execution_completed`.

C'est la démonstration la plus convaincante de la traçabilité : **rien ne se
passe sans laisser de trace.**

---

## Ordre conseillé pour une démonstration de 15 minutes

| Temps | Scénario | Message |
| --- | --- | --- |
| 3 min | 1 | Une phrase, cinq agents, un rapport |
| 3 min | 4 puis 6 | Chaque agent dans son périmètre, puis la combinaison |
| 5 min | 7 | **Rien de sensible ne s'exécute sans un humain** |
| 3 min | 9 et 10 | Le monde extérieur, et une seule alerte par événement |
| 1 min | trace | Tout est audité |
