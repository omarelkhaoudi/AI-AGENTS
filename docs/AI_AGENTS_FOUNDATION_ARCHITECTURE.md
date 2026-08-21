# AI Agents Foundation Architecture

> This document was written during Phase 0 and has been updated from the
> code as the system grew. For a task-oriented entry point, see
> `docs/AGENTS.md`, `docs/DATABASE_SCHEMA.md`,
> `docs/POSTGRESQL_SETUP.md` and `docs/BACKUP_AND_RESTORE.md`.

## Repository Discovered

The `AI AGENTS` directory was empty at the start of Phase 0 and was not a Git repository. No backend, frontend, database, authentication, AI provider, testing, linting, type-checking, or build architecture existed to preserve.

Because there were no local conventions to reuse, Phase 0 establishes a small dependency-free Node.js foundation using ECMAScript modules and the built-in `node:test` runner. The project remains self-contained and does not import or reuse code from any external sibling project.

## Current Scope

This document described Phase 0, when the foundation held technical
boundaries and nothing else. That is no longer what the repository contains,
and the sections below have been brought back in line with the code.

What exists now: ten agents with real permissions, twenty one tools, a
business memory over fifteen domains backed by PostgreSQL, a deterministic
planner that routes sixteen tools, human approval on sensitive actions, and
an audit trail. See `docs/AGENTS.md` and `docs/DATABASE_SCHEMA.md`.

What still does not exist: real n8n workflows, voice input, and external
integrations. Those boundaries are contract-prepared and deliberately
offline.

## Agent Architecture

Agents are defined in `src/agents/contract.js` as validated technical definitions. Each agent can represent:

- identity
- name
- description
- capabilities
- input contract
- output contract
- tools
- permissions
- execution method
- status
- execution metadata

Ten identities are registered in `src/agents/default-agents.js`:

- `director`, `commercial`, `finance`, `production`, `purchasing`
- `hr`, `after_sales`, `marketing`, `community_manager`, `legal`

Their capabilities, tools and permissions are populated. Each carries a
mission, the information it may reach, the actions it may take, and the
actions that need a human. `promptInstructions` stays empty: the default
planner is deterministic and asks no model to decide.

`docs/AGENTS.md` documents all ten, with their tools and security domains.

## Agent Registry

`src/agents/registry.js` provides discovery through:

- `register(agent)`
- `get(agentId)`
- `require(agentId)`
- `list()`
- `has(agentId)`

The registry validates every agent before registration and rejects duplicate IDs.

## Director / Orchestrator

`src/director/orchestrator.js` defines the AI Director boundary. It supports:

- receiving a technical request envelope
- requesting a delegation plan
- delegating planned steps
- collecting agent results
- aggregating results
- returning execution metadata
- surfacing errors through explicit boundaries

The default planner is `createDeterministicPlanner`: it selects agents by
matching the request wording and gives each a fixed tool list from
`DEFAULT_TOOLS_BY_AGENT`. A company overview plans thirteen steps across nine
agents. An LLM planner exists behind the same interface and is selected by
`PLANNER_PROVIDER`; see `docs/PLANNER_CONFIGURATION.md`.

`src/director/request-orchestration.js` runs a plan step by step inside a
transaction, checking permissions, executing tools, and recording an
execution and an audit event for every step, including the ones that stop.

## Permissions

`src/security/permissions.js` defines technical permission kinds:

- `read_analyze`
- `prepare_action`
- `execute_action`
- `human_approval_required`

Agents hold real permissions, built by `createMvpAgentPermissions` and
stored on the `Agent` row. An agent holds exactly the security domains its
own tools need, and `test/security-no-permission-drift.test.js` freezes that
model: widening an agent's reach has to be a deliberate edit of
`src/security/tool-domains.js`.

Reaching a tool takes four independent checks: allowed agent, required
permission kind, every security domain the tool reads, and human approval
for a sensitive action. `docs/AGENTS.md` details them.

## Human Approval

`src/security/approval.js` models reusable approval requests with:

- requested action
- requesting agent
- reason
- affected resource
- risk
- approval status
- approver
- timestamps
- metadata

Three tools never execute on their own: `execute_invoice_payment`,
`prepare_hr_sensitive_decision` and `prepare_legal_sensitive_decision`. They
prepare the action, record an approval, and stop. This implements CDC
section 17 level 3.

## Workflow / n8n Boundary

`src/integrations/workflow-boundary.js` defines a future workflow client boundary and configuration. Workflow invocation deliberately throws in Phase 0.

Configuration supports a provider name, optional base URL, enabled flag, and metadata. If workflows are enabled, a base URL must be supplied.

## AI Provider Boundary

`src/integrations/ai-provider.js` defines a minimal provider configuration and client boundary. Credentials are read from environment variables and never exposed in returned config objects.

External AI calls deliberately throw in Phase 0 so tests remain deterministic and do not require paid APIs.

## Database Foundation

PostgreSQL through Prisma 7, with twenty six models and five committed
migrations. Ten tables hold orchestration — requests, plans, steps,
executions, approvals, audit — and sixteen hold the business memory across
fifteen domains: customers, quotes, invoices, payments, orders, production,
purchase needs, suppliers, HR signals, after sales tickets, products,
prices, stock, bills of material and payment terms.

`src/persistence/in-memory-repository.js` implements the same repository
contract without a database, which is what lets the suite run offline. The
provider is chosen by `BUSINESS_MEMORY_PROVIDER`; both return identical
records, and `test/director-postgres-equivalence.test.js` checks it.

See `docs/DATABASE_SCHEMA.md` and `docs/BACKUP_AND_RESTORE.md`.

## Observability

`src/observability/logger.js` provides structured JSON logging for execution events. It redacts keys containing:

- `apiKey`
- `password`
- `token`
- `secret`
- `authorization`

Execution metadata can identify agent ID, execution ID, status, duration, errors, and related metadata.

## Configuration

`src/config.js` loads Phase 0 configuration from environment variables:

- `NODE_ENV`
- `AI_PROVIDER`
- `AI_PROVIDER_API_KEY`
- `AI_PROVIDER_MODEL`
- `AI_PROVIDER_ENABLED`
- `WORKFLOW_PROVIDER`
- `WORKFLOW_BASE_URL`
- `WORKFLOW_ENABLED`

Validation prevents enabling external AI or workflow calls without required configuration.

## Testing Strategy

The test suite in `test/foundation.test.js` uses Node's built-in test runner. Tests are deterministic and do not require network access, OpenAI, n8n, or company systems.

Coverage includes contract validation, registry behavior, director delegation and aggregation boundaries, permission and approval models, configuration validation, error boundaries, and secret redaction.

## Project Scripts

- `npm run test`: run deterministic Phase 0 tests.
- `npm run lint`: validate JavaScript syntax with `node --check`.
- `npm run typecheck`: reports that TypeScript is not configured in Phase 0.
- `npm run build`: validates syntax as the build gate for this dependency-free Node foundation.
- `npm run scan:secrets`: scans source and docs for common hardcoded secret patterns.
