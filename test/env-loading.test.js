import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";
import { loadFoundationConfig } from "../src/index.js";

// The server read process.env and nothing filled it. A .env that set
// AUTH_MODE="demo" was honoured by npm run db:seed and ignored by npm start, so
// the demo session route never registered and answered 404 while every piece of
// the code that produced it was correct. These tests hold the two halves
// together: the loader itself, and the fact that the entry point calls it.

async function envFile(contents) {
  const directory = await mkdtemp(join(tmpdir(), "ai-agents-env-"));
  const path = join(directory, ".env");
  await writeFile(path, contents, "utf8");
  return path;
}

// process.env is global; every test puts back exactly what it found.
function withCleanKeys(keys, run) {
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      delete process.env[key];
    }
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("the loader fills the keys that are missing", async () => {
  const path = await envFile([
    "# a comment is not a variable",
    "",
    "AI_AGENTS_TEST_MODE=\"demo\"",
    "AI_AGENTS_TEST_PLAIN=token",
    "AI_AGENTS_TEST_SINGLE='quoted'"
  ].join("\n"));

  await withCleanKeys(
    ["AI_AGENTS_TEST_MODE", "AI_AGENTS_TEST_PLAIN", "AI_AGENTS_TEST_SINGLE"],
    () => {
      const loaded = loadDotEnvIfPresent(path);

      assert.deepEqual(loaded.sort(), [
        "AI_AGENTS_TEST_MODE",
        "AI_AGENTS_TEST_PLAIN",
        "AI_AGENTS_TEST_SINGLE"
      ]);
      assert.equal(process.env.AI_AGENTS_TEST_MODE, "demo", "quotes must be stripped");
      assert.equal(process.env.AI_AGENTS_TEST_PLAIN, "token");
      assert.equal(process.env.AI_AGENTS_TEST_SINGLE, "quoted");
    }
  );
});

// A value exported in a shell is an explicit choice. A file must never win over
// it, or an operator could not override a committed default.
test("a variable already exported is never overwritten", async () => {
  const path = await envFile("AI_AGENTS_TEST_MODE=\"demo\"");

  await withCleanKeys(["AI_AGENTS_TEST_MODE"], () => {
    process.env.AI_AGENTS_TEST_MODE = "token";
    const loaded = loadDotEnvIfPresent(path);

    assert.equal(process.env.AI_AGENTS_TEST_MODE, "token", "the shell must win");
    assert.equal(loaded.includes("AI_AGENTS_TEST_MODE"), false);
  });
});

test("a missing file is not an error", () => {
  assert.deepEqual(loadDotEnvIfPresent(join(tmpdir(), "ai-agents-no-such-file.env")), []);
});

// The bug was not in the loader, it was in who called it. This states the link
// the code was missing: what the file sets is what the configuration reports.
test("what the file sets is what the configuration reports", async () => {
  const path = await envFile([
    "AUTH_MODE=\"demo\"",
    "WORKFLOW_PROVIDER=\"mock\"",
    "WORKFLOW_ENABLED=\"false\""
  ].join("\n"));

  await withCleanKeys(["AUTH_MODE", "WORKFLOW_PROVIDER", "WORKFLOW_ENABLED"], () => {
    assert.equal(
      loadFoundationConfig({ NODE_ENV: "test" }).security.demoModeEnabled,
      false,
      "without the file, demo mode is off: this is the 404 that was reported"
    );

    loadDotEnvIfPresent(path);
    const config = loadFoundationConfig({ NODE_ENV: "test", ...process.env });

    assert.equal(config.security.authMode, "demo");
    assert.equal(config.security.demoModeEnabled, true);
  });
});

// The entry point is a process, not a module a test can import: importing it
// would start a server. Its source is read instead, which is enough to state
// that the call is there and runs before anything reads process.env.
test("the server entry point loads the file before it reads the environment", async () => {
  const source = await readFile("src/server.js", "utf8");

  assert.match(source, /import \{ loadDotEnvIfPresent \} from "\.\/load-dotenv\.js";/);

  // Comment lines are dropped first: the comment above the call explains why it
  // is there and names process.env, which would otherwise look like the first
  // read and make this assertion pass or fail for the wrong reason.
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  const call = code.indexOf("loadDotEnvIfPresent();");
  const firstRead = code.indexOf("process.env");
  assert.ok(call > 0, "the entry point must call the loader");
  assert.ok(firstRead > 0, "the entry point is expected to read process.env");
  assert.ok(
    call < firstRead,
    "the loader must be called before the first process.env read"
  );
});

// The loader moved out of scripts/ so the server could use it. The seed scripts
// must have moved with it, or npm run db:seed stops seeing DATABASE_URL.
test("the seed scripts load the file from its new home", async () => {
  for (const script of ["scripts/db-seed.mjs", "scripts/db-seed-business.mjs"]) {
    const source = await readFile(script, "utf8");
    assert.match(
      source,
      /import \{ loadDotEnvIfPresent \} from "\.\.\/src\/load-dotenv\.js";/,
      script
    );
    assert.match(source, /loadDotEnvIfPresent\(\);/, script);
  }
});
