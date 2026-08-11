# AI Agents Foundation Architecture

## Repository Discovered

The `AI AGENTS` directory was empty at the start of Phase 0 and was not a Git repository. No backend, frontend, database, authentication, AI provider, testing, linting, type-checking, or build architecture existed to preserve.

Because there were no local conventions to reuse, Phase 0 establishes a small dependency-free Node.js foundation using ECMAScript modules and the built-in `node:test` runner. The project remains self-contained and does not import or reuse code from any external sibling project.

## Phase 0 Scope

Phase 0 implements technical boundaries only. It does not implement client business logic, company procedures, final permissions, real workflows, real integrations, or production automation.

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

The five MVP identities are registered in `src/agents/default-agents.js`:

- `director`
- `commercial`
- `finance`
- `production`
- `purchasing`

Their capabilities, tools, permissions, and business behavior are intentionally empty placeholders until Hiba and Hicham confirm the CDC details.

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

The default planner returns no steps. The default delegate returns a Phase 0 placeholder result. No business routing is implemented.

## Permissions

`src/security/permissions.js` defines technical permission kinds:

- `read_analyze`
- `prepare_action`
- `execute_action`
- `human_approval_required`

No agent receives final business permissions in Phase 0.

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

This is only a data model. It does not define company approval policies.

## Workflow / n8n Boundary

`src/integrations/workflow-boundary.js` defines a future workflow client boundary and configuration. Workflow invocation deliberately throws in Phase 0.

Configuration supports a provider name, optional base URL, enabled flag, and metadata. If workflows are enabled, a base URL must be supplied.

## AI Provider Boundary

`src/integrations/ai-provider.js` defines a minimal provider configuration and client boundary. Credentials are read from environment variables and never exposed in returned config objects.

External AI calls deliberately throw in Phase 0 so tests remain deterministic and do not require paid APIs.

## Database Foundation

No database architecture existed. Phase 0 includes `src/persistence/in-memory-store.js` for technical execution and approval metadata during tests and early development only.

No final business schema is created. There are no customer, invoice, supplier, production order, payment, product, or employee tables.

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
