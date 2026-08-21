import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  MVP_AGENT_IDS,
  createMvpAgentPermissions,
  seedMvpAgents
} from "../src/index.js";

// The seed used to keep whatever an agent row already carried. An agent stored
// before a lot therefore never received the permissions that lot added, and the
// PostgreSQL Director could execute only the first step of its plan while the
// in-memory one, which recomputes permissions at boot, looked healthy.
test("the seed restores permissions that drifted away from the model", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);

  // A row left behind by an older lot: one permission, and the wrong kind.
  const drifted = [{ kind: "execute_action", resource: "request:*", scope: "technical", metadata: {} }];
  const before = await repository.getAgent("finance");
  await repository.upsertAgent({ ...before, permissions: drifted });
  assert.deepEqual((await repository.getAgent("finance")).permissions, drifted, "the drift is in place");

  await seedMvpAgents(repository);

  assert.deepEqual(
    (await repository.getAgent("finance")).permissions,
    createMvpAgentPermissions("finance"),
    "the seed must bring the row back to the model"
  );
});

test("every seeded agent carries exactly the permissions the model defines", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);

  for (const agentId of MVP_AGENT_IDS) {
    assert.deepEqual(
      (await repository.getAgent(agentId)).permissions,
      createMvpAgentPermissions(agentId),
      agentId
    );
  }
});

// Restoring the model is not the same as granting more: the seed must never be
// a way for an agent to gain access it was not given.
test("the seed grants nothing beyond the model, even from a widened row", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);

  const widened = [
    ...createMvpAgentPermissions("production"),
    { kind: "read_analyze", resource: "domain:payments", scope: "mvp_business_domain", metadata: {} }
  ];
  const before = await repository.getAgent("production");
  await repository.upsertAgent({ ...before, permissions: widened });

  await seedMvpAgents(repository);
  const after = await repository.getAgent("production");

  assert.deepEqual(after.permissions, createMvpAgentPermissions("production"));
  assert.equal(
    after.permissions.some((permission) => permission.resource === "domain:payments"),
    false,
    "production must not keep a payments domain it was never granted"
  );
});

test("seeding twice leaves exactly the same permissions", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const first = await Promise.all(MVP_AGENT_IDS.map((id) => repository.getAgent(id)));
  await seedMvpAgents(repository);
  const second = await Promise.all(MVP_AGENT_IDS.map((id) => repository.getAgent(id)));

  assert.deepEqual(
    second.map((agent) => agent.permissions),
    first.map((agent) => agent.permissions)
  );
});
