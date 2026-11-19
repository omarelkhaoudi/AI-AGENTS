import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { buildApi } from "../src/api/server.js";

test("the cockpit installs as an app: a manifest with the company's name, its icons, and the page links them", async (t) => {
  const app = buildApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const manifest = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
  assert.equal(manifest.statusCode, 200);
  assert.match(manifest.headers["content-type"], /application\/manifest\+json/);
  const body = manifest.json();
  assert.equal(body.short_name, "H-KIDS");
  assert.deepEqual([body.start_url, body.display], ["/app/", "standalone"]);
  assert.deepEqual(body.icons.map((icon) => icon.sizes), ["192x192", "512x512", "512x512"]);
  assert.ok(body.icons.some((icon) => icon.purpose === "maskable"));

  for (const icon of [...body.icons.map((entry) => entry.src), "/app/icons/apple-touch-icon.png"]) {
    const image = await app.inject({ method: "GET", url: icon });
    assert.equal(image.statusCode, 200, icon);
    assert.equal(image.headers["content-type"], "image/png");
    assert.deepEqual([...image.rawPayload.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a real PNG");
  }
  assert.equal((await app.inject({ method: "GET", url: "/app/icons/..%2Fapp.js" })).statusCode, 404);

  const page = (await app.inject({ method: "GET", url: "/app/" })).body;
  assert.match(page, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(page, /<link rel="apple-touch-icon" href="\/app\/icons\/apple-touch-icon.png">/);
});
