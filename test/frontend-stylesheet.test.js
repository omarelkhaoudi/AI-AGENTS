import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The cockpit serves a compiled stylesheet, committed so the app needs no build
// step. It must be the one its Tailwind source produces today: a class added to
// index.html or app.js without running npm run css:build would ship unstyled.
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "node_modules", "@tailwindcss", "cli", "dist", "index.mjs");

test("the committed stylesheet is what the Tailwind source compiles to", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hkids-css-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "styles.css");

  const run = spawnSync(process.execPath, [cli, "-i", "src/frontend/tailwind.css", "-o", output, "--minify"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);

  // Git may check the file out with CRLF line endings on Windows.
  const read = async (path) => (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
  assert.ok(await read(join(root, "src", "frontend", "styles.css")) === await read(output), "src/frontend/styles.css is stale: run npm run css:build");
});
