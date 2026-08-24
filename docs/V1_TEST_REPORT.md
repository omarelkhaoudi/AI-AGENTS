# Rapport de tests — V1 MVP

**Commit de référence : `c2c1d89`** — *feat: add persistent delay alert idempotency*

Ce rapport ne contient que des résultats réellement produits par la suite du
dépôt à ce commit. Aucun chiffre n'est estimé ni extrapolé.

---

## 1. Résultat principal — avec PostgreSQL

Environnement : `DATABASE_URL` renseignée, `RUN_POSTGRES_INTEGRATION="true"`,
`AUTH_MODE="token"`.

```bash
npm test
```

```
tests       723
suites        0
pass        723
fail          0
cancelled     0
skipped       0
todo          0
duration    36 455 ms
```

**723 tests, 723 réussis, 0 échec, 0 ignoré.**

---

## 2. Résultat secondaire — sans PostgreSQL

Aucune variable de base renseignée. C'est la configuration par défaut d'un poste
qui vient de cloner le dépôt.

```bash
npm test
```

```
tests       723
pass        693
fail          0
skipped      30
duration    23 506 ms
```

**Les 30 tests ignorés sont les tests d'intégration PostgreSQL.** Ils se
désactivent d'eux-mêmes en l'absence de base : c'est le comportement attendu, pas
une défaillance. Aucun test n'échoue dans cette configuration.

---

## 3. Périmètre

| Élément | Valeur |
| --- | --- |
| Fichiers de tests | **65** |
| Exécuteur | `node --test`, natif |
| Dépendance de test externe | **aucune** |

---

## 4. Catégories couvertes

### Fondations et orchestration
`foundation` · `mvp-foundation` · `orchestration` · `orchestration-blocked-observability`
· `mvp-multi-agent` · `agent-permission-sync` · `api-seed-resilience`

Cycle complet demande → plan → étape → exécution, semis idempotent des agents,
observabilité des orchestrations bloquées.

### Sécurité, permissions et validation humaine
`authentication` · `authorization` · `permissions-resource-matching` ·
`security-no-permission-drift` · `security-postgres` · `rate-limit` ·
`request-limits` · `scan-secrets`

Authentification par jeton haché, capacités par rôle, correspondance de
ressources, **gel du modèle de moindre privilège**, limitation de débit, absence
de secret en dur.

### Approbations
`approval-flow` · `approval-integrity` · `approval-atomicity`

Une approbation exige un approbateur réel et habilité ; elle ne peut être
**décidée** qu'une fois ni **dépensée** qu'une fois ; ces garanties sont
vérifiées **sous concurrence PostgreSQL**, y compris lorsqu'une approbation et un
rejet se disputent la même décision.

### Business Memory
`business-memory` · `business-memory-factory` · `business-memory-postgres` ·
`business-memory-read-contract` · `business-memory-repository-parity` ·
`business-memory-source-isolation` · `business-memory-tool-security` ·
`business-memory-ingestion` · `business-domain-registry` ·
`business-record-sequence` · `business-provider-contract` ·
`business-provider-adapter` · `business-date-convention`

**Parité mémoire ↔ PostgreSQL**, isolation par source, contrôle d'accès par
domaine, ordre de tri stable, convention de date unique.

### Outils métier
`business-tools-read` · `tool-registry` · `tool-adapter-layer` ·
`tool-execution-service` · `multi-domain-tool-scoping` · `commercial-follow-ups`
· `finance-receivables` · `material-requirements` · `production-classification`

Les quatre contrôles d'autorisation précédant tout appel d'outil, et les calculs
métier : relances commerciales, créances, besoins matière, états de production.

### Directeur et rapport dirigeant
`director-cdc-sections` · `director-readability` · `director-presentation-domains`
· `director-production-states` · `director-routing-2c` ·
`director-postgres-equivalence` · `frontend`

Les 10 rubriques du cahier des charges, la lisibilité des libellés, l'absence de
doublon entre rubriques, et **l'équivalence du rapport entre mémoire et
PostgreSQL**.

### Planificateur
`planner-contract` · `planner-factory` · `planner-multi-step` · `llm-planner` ·
`openai-provider`

Contrat de plan, sélection du fournisseur, plans multi-étapes, et le fait qu'un
planificateur LLM **ne peut jamais exécuter un outil** ni en inventer un.

### Intégration n8n
`workflow-contract` · `workflow-activation` · `integration-layer-contract` ·
`n8n-config` · `n8n-client` · `n8n-adapter` · `notify-delay-alert` ·
`delay-alert-endpoint` · `delay-alert-dedup`

Activation délibérée de la frontière, lecture de configuration **sans jamais
exposer le jeton**, client HTTP et ses modes d'échec, adaptateur derrière le
registre, approbation humaine obligatoire, et **déduplication persistante**.

> **Aucun test n'effectue d'appel réseau réel.** Cela a été vérifié en relançant
> la suite complète avec `globalThis.fetch` remplacé par une sentinelle qui
> échoue : elle ne s'est jamais déclenchée, et les 723 tests sont passés.

### Persistance
`postgres-integration` · `business-memory-postgres` · `security-postgres` ·
`director-postgres-equivalence` · `approval-atomicity` · `delay-alert-dedup`

Ce sont les tests qui exigent une base réelle. Ils sont ignorés sans
`DATABASE_URL`.

### Documentation et conformité
`documentation-consistency` · `cdc-business-memory-sop` · `sop`

**La documentation est testée comme du code** : tout agent, outil, domaine,
modèle Prisma ou migration ajouté sans ligne correspondante dans la
documentation fait échouer la suite.

---

## 5. Contrôles complémentaires

Tous exécutés au commit `c2c1d89`, tous réussis :

```bash
npm run lint
```

```bash
npm run build
```

```bash
npm run scan:secrets
```

```bash
git diff --check
```

`scan:secrets` répond : *No hardcoded secrets matched the Phase 0 scan patterns.*

---

## 6. Reproduire ce rapport

**Sans base** — aucune configuration nécessaire :

```bash
npm test
```

**Avec base** — exporter `DATABASE_URL` et `RUN_POSTGRES_INTEGRATION="true"`,
puis la même commande.

Les durées dépendent de la machine ; les compteurs de tests, eux, ne dépendent
que du commit.

---

## 7. Limites de ce rapport

**Aucune mesure de couverture de code n'est produite.** Le dépôt n'intègre pas
d'outil de couverture ; annoncer un pourcentage serait une invention.

**Aucun test de charge ni de performance** n'est présent. Les durées ci-dessus
mesurent la suite, pas l'application en service.

**Les tests n'appellent jamais n8n réellement.** L'intégration a été validée
séparément, à la main, contre le webhook de production.
