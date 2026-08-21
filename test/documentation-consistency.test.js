import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  AGENT_SECURITY_DOMAINS,
  BUSINESS_DOMAINS,
  MVP_AGENT_IDS,
  createMvpToolRegistry
} from "../src/index.js";

// The architecture document spent several lots claiming five agents, empty
// permissions and no business tables, long after all three had stopped being
// true. Documentation that is only prose drifts silently; these tests fail when
// it does, so a model, tool, agent or domain added without a line here is
// caught by the suite rather than by whoever inherits the project.
async function doc(name) {
  return readFile(`docs/${name}`, "utf8");
}

test("every agent is documented, and no agent is invented", async () => {
  const agents = await doc("AGENTS.md");
  const headings = [...agents.matchAll(/^### (\w+) — /gm)].map((match) => match[1]);

  assert.deepEqual(headings, [...MVP_AGENT_IDS], "documented agents must be the registered ones, in order");
});

test("every registered tool is documented, and no tool is invented", async () => {
  const agents = await doc("AGENTS.md");
  const registered = createMvpToolRegistry().list().map((tool) => tool.id);
  // prepare_action and execute_action are permission kinds, not tools.
  const permissionKinds = new Set(["read_analyze", "prepare_action", "execute_action", "human_approval_required"]);
  const documented = new Set(
    [...agents.matchAll(/`(get_\w+|execute_\w+|prepare_\w+)`/g)]
      .map((match) => match[1])
      .filter((token) => !permissionKinds.has(token))
  );

  for (const toolId of registered) {
    assert.ok(documented.has(toolId), `${toolId} is registered but not documented`);
  }
  for (const toolId of documented) {
    assert.ok(registered.includes(toolId), `${toolId} is documented but not registered`);
  }
});

test("each agent is documented with the tools it is actually allowed", async () => {
  const agents = await doc("AGENTS.md");
  const tools = createMvpToolRegistry().list();

  for (const agentId of MVP_AGENT_IDS) {
    const section = agents.split(`### ${agentId} — `)[1]?.split("\n### ")[0];
    assert.ok(section, `${agentId} has no section`);

    const allowed = tools.filter((tool) => tool.allowedAgents.includes(agentId)).map((tool) => tool.id);
    const line = section.split("\n").find((entry) => entry.startsWith("- **Tools"));
    assert.ok(line, `${agentId} documents no tools`);

    assert.match(line, new RegExp(`\\(${allowed.length}\\)`), `${agentId} must document ${allowed.length} tool(s)`);
    for (const toolId of allowed) {
      assert.ok(line.includes(`\`${toolId}\``), `${agentId} may call ${toolId} but does not document it`);
    }
  }
});

test("each agent is documented with the security domains it actually holds", async () => {
  const agents = await doc("AGENTS.md");

  for (const agentId of MVP_AGENT_IDS) {
    const section = agents.split(`### ${agentId} — `)[1]?.split("\n### ")[0];
    const line = section.split("\n").find((entry) => entry.startsWith("- **Security domains**"));
    assert.ok(line, `${agentId} documents no security domains`);

    for (const domain of AGENT_SECURITY_DOMAINS[agentId]) {
      assert.ok(line.includes(domain), `${agentId} holds ${domain} but does not document it`);
    }
  }
});

test("every business domain is documented, and no domain is invented", async () => {
  const schema = await doc("DATABASE_SCHEMA.md");
  const documented = [...schema.matchAll(/^\| `(\w+)` \| `(\w+)` \| `(\w+)` \|/gm)].map((match) => match[1]);

  assert.deepEqual(documented, [...BUSINESS_DOMAINS], "documented domains must be the declared ones, in order");
});

test("every domain is documented against the Prisma model it really uses", async () => {
  const schema = await doc("DATABASE_SCHEMA.md");
  const repository = await readFile("src/business-memory/prisma-business-memory-repository.js", "utf8");
  const delegates = Object.fromEntries(
    [...repository.matchAll(/(\w+): Object\.freeze\(\{\s*delegate: "(\w+)"/g)].map((match) => [match[1], match[2]])
  );

  // Three backticked columns identify the domain table. The migration table
  // has two, and would otherwise be read as a domain.
  for (const [, domain, model] of schema.matchAll(/^\| `(\w+)` \| `(\w+)` \| `(\w+)` \|/gm)) {
    const expected = delegates[domain];
    assert.ok(expected, `${domain} is documented but maps to no delegate`);
    // The document names the Prisma model; the code names the client delegate,
    // which is the same name with a lowercase first letter.
    assert.equal(
      `${model[0].toLowerCase()}${model.slice(1)}`,
      expected,
      `${domain} is documented as ${model} but the code uses ${expected}`
    );
  }
});

test("every Prisma model is documented", async () => {
  const schema = await doc("DATABASE_SCHEMA.md");
  const prisma = await readFile("prisma/schema.prisma", "utf8");
  const models = [...prisma.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]);

  assert.equal(models.length, 26, "the count in the document is stated per family");
  for (const model of models) {
    assert.ok(schema.includes(`\`${model}\``), `${model} exists in the schema but is documented nowhere`);
  }
});

test("every committed migration is documented", async () => {
  const schema = await doc("DATABASE_SCHEMA.md");
  const { readdir } = await import("node:fs/promises");
  const migrations = (await readdir("prisma/migrations", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  assert.ok(migrations.length > 0);
  for (const migration of migrations) {
    assert.ok(schema.includes(`\`${migration}\``), `${migration} is applied but documented nowhere`);
  }
});

// Backup is the one procedure that cannot be re-derived from the code, so the
// document must at least name the commands it relies on.
test("the backup document names the commands it describes", async () => {
  const backup = await doc("BACKUP_AND_RESTORE.md");

  for (const command of ["pg_dump", "pg_restore", "npm run db:migrate", "npm run db:seed"]) {
    assert.ok(backup.includes(command), `the backup procedure must name ${command}`);
  }
});

test("the npm scripts the documents tell a reader to run all exist", async () => {
  const scripts = Object.keys(JSON.parse(await readFile("package.json", "utf8")).scripts);
  const documents = await Promise.all(
    ["AGENTS.md", "DATABASE_SCHEMA.md", "BACKUP_AND_RESTORE.md", "POSTGRESQL_SETUP.md"].map((name) => doc(name))
  );

  for (const content of documents) {
    for (const [, script] of content.matchAll(/npm run ([\w:]+)/g)) {
      assert.ok(scripts.includes(script), `npm run ${script} is documented but not defined`);
    }
  }
});

// The claims that were wrong for several lots. They must not come back.
test("no document repeats a claim the code has outgrown", async () => {
  const stale = [
    "five MVP identities",
    "No database architecture existed",
    "There are no customer, invoice, supplier",
    "intentionally empty placeholders",
    "No agent receives final business permissions",
    "The default planner returns no steps"
  ];
  const documents = await Promise.all(
    ["AI_AGENTS_FOUNDATION_ARCHITECTURE.md", "AGENTS.md", "DATABASE_SCHEMA.md", "BACKUP_AND_RESTORE.md"].map((name) =>
      doc(name)
    )
  );

  for (const content of documents) {
    for (const claim of stale) {
      assert.equal(content.includes(claim), false, `a document still claims: ${claim}`);
    }
  }
});
