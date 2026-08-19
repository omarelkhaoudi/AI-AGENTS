import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi, createMvpAgentSeedRecords } from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// One seed writes exactly one upsert per seeded agent. Deriving the count from
// the seed definition keeps the assertions exact without hardcoding a number
// that would drift the day an agent is added.
const AGENTS_PER_SEED = createMvpAgentSeedRecords().length;

const POINT_REQUEST = Object.freeze({ message: "Fais-moi le point sur mon entreprise aujourd'hui." });

class FlakySeedRepository extends InMemoryRepository {
  constructor({ failures = 1 } = {}) {
    super();
    this.remainingFailures = failures;
    // Every call, successful or not: this is what detects a replayed seed.
    this.upsertAgentCalls = 0;
    this.failedSeedAttempts = 0;
  }

  async upsertAgent(agent) {
    this.upsertAgentCalls += 1;

    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      this.failedSeedAttempts += 1;
      throw new Error("Seed storage unavailable.");
    }

    return super.upsertAgent(agent);
  }
}

function postRequest(inject, payload = POINT_REQUEST) {
  return inject({ method: "POST", url: "/api/requests", payload });
}

test("a failed seed does not poison the API: the next request retries it", async (t) => {
  const repository = new FlakySeedRepository({ failures: 1 });
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const firstResponse = await postRequest(inject);

  assert.equal(firstResponse.statusCode, 500);
  assert.equal(repository.failedSeedAttempts, 1);

  const secondResponse = await postRequest(inject);

  assert.equal(secondResponse.statusCode, 201);
  assert.equal(JSON.parse(secondResponse.body).request.status, "orchestrated");
  // The retry replays the whole seed once: the failed upsert plus a full pass.
  assert.equal(repository.upsertAgentCalls, AGENTS_PER_SEED + 1);
  assert.equal((await repository.listAgents()).length, AGENTS_PER_SEED);
});

test("a successful seed stays memoized and is not replayed", async (t) => {
  const repository = new FlakySeedRepository({ failures: 0 });
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const first = await postRequest(inject);
  const agentCountAfterFirst = (await repository.listAgents()).length;

  const second = await postRequest(inject);

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.ok(agentCountAfterFirst > 0);
  assert.equal((await repository.listAgents()).length, agentCountAfterFirst);
  assert.equal(repository.upsertAgentCalls, AGENTS_PER_SEED);
});

test("concurrent first requests seed exactly once, and later requests never re-seed", async (t) => {
  const repository = new FlakySeedRepository({ failures: 0 });
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const concurrentResponses = await Promise.all([
    postRequest(inject),
    postRequest(inject),
    postRequest(inject),
    postRequest(inject),
    postRequest(inject)
  ]);

  for (const response of concurrentResponses) {
    assert.equal(response.statusCode, 201);
  }

  // Five concurrent requests must share a single seed. Without memoization this
  // would be 5 * AGENTS_PER_SEED upserts, so the assertion fails if the shared
  // seed promise is removed.
  assert.equal(repository.upsertAgentCalls, AGENTS_PER_SEED);
  assert.equal((await repository.listAgents()).length, AGENTS_PER_SEED);

  const laterResponse = await postRequest(inject);
  const evenLaterResponse = await postRequest(inject);

  assert.equal(laterResponse.statusCode, 201);
  assert.equal(evenLaterResponse.statusCode, 201);
  assert.equal(repository.upsertAgentCalls, AGENTS_PER_SEED);
  assert.equal((await repository.listAgents()).length, AGENTS_PER_SEED);
});
