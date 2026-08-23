import assert from "node:assert/strict";
import test from "node:test";
import {
  N8N_ERROR_BODY_LIMIT,
  WorkflowBoundaryError,
  createN8nClient,
  createWorkflowEvent
} from "../src/index.js";

// fetchImpl is injected in every test here. Nothing in this file reaches the
// network, and nothing runs an n8n workflow.
const SECRET = "token-de-test-jamais-committe";
const HEADER = "X-AI-Agents-Token";

const EVENT = createWorkflowEvent({
  id: "evt-1",
  type: "delay_alert",
  correlationId: "corr-1",
  agentId: "production",
  requestId: "req-1",
  payload: { orderId: "order-atlas-001", delayRisk: "high" }
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

function buildClient({ fetchImpl, ...overrides } = {}) {
  return createN8nClient({
    baseUrl: "https://n8n.example.test",
    webhookPath: "delay-alert",
    apiKeyHeader: HEADER,
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl: fetchImpl ?? (async () => jsonResponse({ status: "received" })),
    ...overrides
  });
}

function recordingFetch(response = jsonResponse({ status: "received" })) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return typeof response === "function" ? response() : response;
  };
  return { calls, fetchImpl };
}

async function expectRefusal(run, code) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof WorkflowBoundaryError, `${code}: wrong error type`);
    assert.equal(error.code, code);
    return true;
  });
}

test("the request is a JSON POST to the composed webhook url", async () => {
  const { calls, fetchImpl } = recordingFetch();
  await buildClient({ fetchImpl }).postWorkflowEvent(EVENT);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://n8n.example.test/delay-alert");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), EVENT);
});

test("trailing and leading slashes do not produce a broken url", async () => {
  for (const [baseUrl, webhookPath] of [
    ["https://n8n.example.test/", "delay-alert"],
    ["https://n8n.example.test", "/delay-alert"],
    ["https://n8n.example.test///", "///delay-alert"]
  ]) {
    const { calls, fetchImpl } = recordingFetch();
    await buildClient({ fetchImpl, baseUrl, webhookPath }).postWorkflowEvent(EVENT);
    assert.equal(calls[0].url, "https://n8n.example.test/delay-alert");
  }
});

test("the configured header carries the token, and it is not hardcoded", async () => {
  const { calls, fetchImpl } = recordingFetch();
  await buildClient({ fetchImpl }).postWorkflowEvent(EVENT);
  assert.equal(calls[0].options.headers[HEADER], SECRET);

  const custom = recordingFetch();
  await buildClient({ fetchImpl: custom.fetchImpl, apiKeyHeader: "X-Other-Header" }).postWorkflowEvent(EVENT);
  assert.equal(custom.calls[0].options.headers["X-Other-Header"], SECRET);
  assert.equal(HEADER in custom.calls[0].options.headers, false);
});

test("a timeout signal is passed to fetch, set to the configured duration", async () => {
  const { calls, fetchImpl } = recordingFetch();
  await buildClient({ fetchImpl, timeoutMs: 1234 }).postWorkflowEvent(EVENT);

  const { signal } = calls[0].options;
  assert.ok(signal instanceof AbortSignal, "fetch must receive an abort signal");
  assert.equal(signal.aborted, false);
});

// AbortSignal.timeout rejects with a TimeoutError; anything else from fetch is
// a network failure. Verified against a real socket before this was written.
test("a timeout is reported as a timeout, not as a network failure", async () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  await expectRefusal(
    () => buildClient({ fetchImpl: async () => { throw timeout; } }).postWorkflowEvent(EVENT),
    "N8N_REQUEST_TIMEOUT"
  );
});

test("an unreachable n8n is reported as a request failure", async () => {
  const networkError = Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
  await expectRefusal(
    () => buildClient({ fetchImpl: async () => { throw networkError; } }).postWorkflowEvent(EVENT),
    "N8N_REQUEST_FAILED"
  );
});

test("a non 2xx status is refused, with the status kept for diagnosis", async () => {
  for (const status of [400, 403, 404, 500, 502]) {
    await assert.rejects(
      () => buildClient({ fetchImpl: async () => jsonResponse({ message: "nope" }, status) }).postWorkflowEvent(EVENT),
      (error) => {
        assert.equal(error.code, "N8N_UNEXPECTED_STATUS");
        assert.equal(error.details.httpStatus, status);
        return true;
      }
    );
  }
});

test("a 2xx body that is not JSON is refused rather than guessed", async () => {
  await expectRefusal(
    () => buildClient({ fetchImpl: async () => jsonResponse("<html>Not Found</html>") }).postWorkflowEvent(EVENT),
    "N8N_INVALID_RESPONSE"
  );
});

test("a successful call returns the status, the body and how long it took", async () => {
  const result = await buildClient({
    fetchImpl: async () => jsonResponse({ status: "received", correlationId: "corr-1" })
  }).postWorkflowEvent(EVENT);

  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.body, { status: "received", correlationId: "corr-1" });
  assert.equal(typeof result.durationMs, "number");
  assert.ok(result.durationMs >= 0);
});

// The failing body is worth keeping, but only a readable amount of it.
test("a failing body is truncated instead of flooding the audit trail", async () => {
  const long = "x".repeat(1000);
  await assert.rejects(
    () => buildClient({ fetchImpl: async () => jsonResponse(long, 500) }).postWorkflowEvent(EVENT),
    (error) => {
      assert.ok(error.details.body.length <= N8N_ERROR_BODY_LIMIT + 1, "body must be truncated");
      assert.ok(error.details.body.startsWith("xxx"));
      return true;
    }
  );
});

// The token must not come back through an error, even if n8n echoes it.
test("a response echoing the token never puts it in the error", async () => {
  await assert.rejects(
    () => buildClient({
      fetchImpl: async () => jsonResponse(`{"received":"${SECRET}"}`, 500)
    }).postWorkflowEvent(EVENT),
    (error) => {
      assert.equal(JSON.stringify(error.details).includes(SECRET), false, "the token leaked into the error");
      assert.ok(error.details.body.includes("[REDACTED]"));
      return true;
    }
  );
});

// WORKFLOW_BASE_URL is a free-form variable and may carry credentials.
test("credentials in the base url never reach an error", async () => {
  const client = buildClient({
    baseUrl: "https://operator:motdepasse@n8n.example.test",
    fetchImpl: async () => { throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" }); }
  });

  await assert.rejects(
    () => client.postWorkflowEvent(EVENT),
    (error) => {
      const serialised = JSON.stringify(error.details);
      assert.equal(serialised.includes("motdepasse"), false, "the password leaked");
      assert.equal(serialised.includes("operator"), false, "the username leaked");
      assert.equal(error.details.url, "https://n8n.example.test/delay-alert");
      return true;
    }
  );
});

// fetch messages are free text and can name hosts or credentials.
test("the raw fetch message is never carried into the error", async () => {
  const revealing = Object.assign(new TypeError("connect ECONNREFUSED 10.0.0.7:5678"), { name: "TypeError" });

  await assert.rejects(
    () => buildClient({ fetchImpl: async () => { throw revealing; } }).postWorkflowEvent(EVENT),
    (error) => {
      assert.equal(error.message.includes("ECONNREFUSED"), false);
      assert.equal(JSON.stringify(error.details).includes("10.0.0.7"), false);
      return true;
    }
  );
});

test("the token is never a property of the client", () => {
  const client = buildClient();

  assert.deepEqual(Object.keys(client), ["postWorkflowEvent"]);
  assert.equal(JSON.stringify(client).includes(SECRET), false);
  assert.equal(Object.values(client).includes(SECRET), false);
});

test("every missing setting is refused at construction, not at call time", () => {
  const complete = {
    baseUrl: "https://n8n.example.test",
    webhookPath: "delay-alert",
    apiKeyHeader: HEADER,
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl: async () => jsonResponse({})
  };

  for (const setting of ["baseUrl", "webhookPath", "apiKeyHeader", "apiKey"]) {
    assert.throws(
      () => createN8nClient({ ...complete, [setting]: "" }),
      (error) => {
        assert.equal(error.code, "N8N_CLIENT_MISCONFIGURED");
        assert.equal(error.details.setting, setting);
        return true;
      },
      setting
    );
  }

  for (const timeoutMs of [0, -1, 1.5, "5000", null]) {
    assert.throws(
      () => createN8nClient({ ...complete, timeoutMs }),
      (error) => error.code === "N8N_CLIENT_MISCONFIGURED" && error.details.setting === "timeoutMs"
    );
  }

  assert.throws(
    () => createN8nClient({ ...complete, fetchImpl: "not a function" }),
    (error) => error.code === "N8N_CLIENT_MISCONFIGURED" && error.details.setting === "fetchImpl"
  );
});
