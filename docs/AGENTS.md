# Agents: roles, tools and permissions

Ten agents, defined in `src/agents/default-agents.js` and seeded into the
`Agent` table by `npm run db:seed`. This document is checked against the code by
`test/documentation-consistency.test.js`.

## A note on prompts

CDC section 21 asks for the agents' prompts. **There are none, and none are
missing.** Every agent carries an empty `promptInstructions: []`, because the
default planner is deterministic: `src/director/deterministic-planner.js` picks
agents by matching the request wording and assigns each a fixed tool list. No
model is asked to decide anything.

One prompt does exist: `src/director/planner-prompt.js` builds the `system` and
`user` messages for the LLM planner. It runs only when `PLANNER_PROVIDER` is
`llm_mock` or `llm_openai`; the default is `deterministic`, so it does not run
in the standard configuration. See `docs/PLANNER_CONFIGURATION.md`.

What each agent *is* lives in its `metadata`: mission, responsibilities,
accessible information, authorized actions, actions needing approval, and where
it sits in the hierarchy. That is documented below.

## Hierarchy

The Director orchestrates and supervises eight agents directly. The Community
Manager reports to Marketing, not to the Director: a social signal reaches the
Director through Marketing.

```
director
├── commercial   ├── production   ├── hr            ├── marketing
├── finance      ├── purchasing   ├── after_sales   │   └── community_manager
└── legal
```

The Director itself holds one tool, `get_company_overview`, which the planner
does not route: it orchestrates, it does not execute.

## The ten agents

### director — Director
- **Mission** — Understand the leader request, create a safe plan, delegate to specialized agents, and consolidate results.
- **Accessible information** — request_context, agent_catalog, tool_catalog, execution_status
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action, human_approval_required
- **Sensitivity** — medium
- **Tools (1)** — `get_company_overview`
- **Security domains** — company_overview

### commercial — Commercial
- **Mission** — Identify commercial priorities, quote follow-ups, and customer actions to prepare.
- **Accessible information** — customers, quotes, orders, commercial_pipeline
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action
- **Sensitivity** — medium
- **Tools (7)** — `get_pending_quotes`, `get_customer_overview`, `get_customer_orders`, `get_quote_follow_ups`, `get_order_book_summary`, `get_product_datasheet`, `prepare_quote_from_datasheet`
- **Security domains** — quotes, customers, orders, products, prices

### finance — Administration / Finance
- **Mission** — Analyze receivables, payment priorities, and finance administration signals.
- **Accessible information** — payments, receivables, invoices, customers, finance_overview
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action, human_approval_required
- **Sensitivity** — high
- **Tools (7)** — `get_company_overview`, `get_pending_payments`, `get_customer_overview`, `get_overdue_invoices`, `get_receivables_summary`, `get_revenue_summary`, `execute_invoice_payment`
- **Security domains** — company_overview, payments, customers, invoices

### production — Production
- **Mission** — Identify delayed or at-risk production orders and prepare operational recommendations.
- **Accessible information** — orders, production, production_orders, delivery_risks, capacity_signals
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action
- **Sensitivity** — medium
- **Tools (3)** — `get_delayed_production_orders`, `get_customer_orders`, `get_production_schedule`
- **Conditional tool** — `notify_delay_alert` is registered only when an n8n workflow client is injected. It is the one tool that leaves the company, it is not routed by the planner, and it requires a human approval on every call.
- **Security domains** — production, orders, external_notifications

### purchasing — Achats
- **Mission** — Identify purchase needs and prepare procurement recommendations.
- **Accessible information** — purchase_needs, suppliers, orders, supplier_items, stock_signals
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action
- **Sensitivity** — medium
- **Tools (3)** — `get_purchase_needs`, `get_supplier_catalog`, `get_material_requirements`
- **Security domains** — purchase_needs, suppliers, orders, bills_of_material, stock, products

### hr — Ressources Humaines
- **Mission** — Analyze HR administration, workforce needs, absences, contracts, incidents, and staffing signals without exposing real personal data.
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action, human_approval_required
- **Sensitivity** — high
- **Tools (2)** — `get_hr_overview`, `prepare_hr_sensitive_decision`
- **Security domains** — hr

### after_sales — SAV / Qualite
- **Mission** — Centralize post-delivery issues, quality claims, warranty follow-up, interventions, and customer satisfaction until closure preparation.
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action
- **Sensitivity** — medium
- **Tools (1)** — `get_after_sales_overview`
- **Security domains** — after_sales

### marketing — Marketing
- **Mission** — Analyze marketing priorities, campaign signals, content needs, and supervise community management work.
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action
- **Sensitivity** — medium · **Supervises** — community_manager
- **Tools (1)** — `get_marketing_overview`
- **Security domains** — marketing

### community_manager — Community Manager
- **Mission** — Review community and editorial priorities for Marketing without accessing unrelated confidential data.
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action
- **Sensitivity** — low · **Reports to** — marketing
- **Tools (1)** — `get_community_overview`
- **Security domains** — community

### legal — Juridique
- **Mission** — Identify legal priorities, contract risks, clauses, deadlines, and documents requiring leader or lawyer validation.
- **Authorized** — read_analyze, prepare_action · **Needs approval** — execute_action, human_approval_required
- **Sensitivity** — high
- **Tools (2)** — `get_legal_overview`, `prepare_legal_sensitive_decision`
- **Security domains** — legal

## How a tool is authorized

Twenty one tools are registered in `src/tools/mvp-tools.js`. Reaching one takes
four independent checks, and all four must pass:

1. **`allowedAgents`** — the tool names the agents that may call it.
2. **`requiredPermission`** — `read_analyze`, `prepare_action` or `execute_action`, matched against the agent's stored permissions.
3. **`securityDomains`** — the agent must hold **every** domain the tool reads. A tool reading payments and invoices is refused to an agent holding only payments.
4. **Approval** — a tool marked sensitive prepares the action and stops. A human decides.

The domain scopes are `AGENT_SECURITY_DOMAINS` and `TOOL_SECURITY_DOMAINS` in
`src/security/tool-domains.js`, frozen by
`test/security-no-permission-drift.test.js`: changing an agent's reach has to be
a deliberate edit of that file.

An agent holds exactly the domains its own tools need. Nothing is granted to
make a test pass.

## Sensitive tools

Three tools never execute on their own. They prepare an action, record an
approval, and wait:

| Tool | Agent | Prepares |
| --- | --- | --- |
| `execute_invoice_payment` | finance | An invoice payment |
| `prepare_hr_sensitive_decision` | hr | An HR decision |
| `prepare_legal_sensitive_decision` | legal | A legal commitment |

This is CDC section 17 level 3: the agent prepares, the human authorizes.

## Which tools the planner routes

The deterministic planner routes sixteen of the twenty one tools, listed in
`DEFAULT_TOOLS_BY_AGENT`. Four agents carry two tools each — a historical one
and a computing one, in that order:

| Agent | Historical | Computing |
| --- | --- | --- |
| finance | `get_pending_payments` | `get_receivables_summary` |
| commercial | `get_pending_quotes` | `get_quote_follow_ups` |
| production | `get_delayed_production_orders` | `get_production_schedule` |
| purchasing | `get_purchase_needs` | `get_material_requirements` |

Five tools are registered and authorized but not routed by the planner:
`get_company_overview`, `get_customer_overview`, `get_customer_orders`,
`get_overdue_invoices`, `get_supplier_catalog`. They are reachable through the
tool execution service, not through a Director request.
