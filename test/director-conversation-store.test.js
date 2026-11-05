import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { createFileConversationStore } from "../src/agent/conversation-store.js";

// A restart or a new deployment must not make the Director forget a
// conversation, and one person's conversation is never continued by another.

function agentWith(store, inputs) {
  return createDirectorAgent({
    client: { responses: { create: async (payload) => {
      inputs.push(payload.input.map((item) => item.content));
      return { output_text: "Noté.", output: [] };
    } } },
    documentService: {},
    conversationStore: store,
    clock: () => new Date("2026-11-05T10:00:00Z")
  });
}

test("a conversation kept on disk is picked up by a new server, for its owner only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hkids-conversations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputs = [];

  const first = await agentWith(createFileConversationStore({ dir }), inputs).chat({ message: "Le client s'appelle Karim.", userId: "hiba" });
  assert.deepEqual(await readdir(dir), [`${first.conversationId}.json`]);

  // A new agent, as after a restart, reading the same directory.
  const restarted = agentWith(createFileConversationStore({ dir }), inputs);
  const second = await restarted.chat({ message: "Comment s'appelle le client ?", conversationId: first.conversationId, userId: "hiba" });
  assert.equal(second.conversationId, first.conversationId);
  assert.deepEqual(inputs.at(-1), ["Le client s'appelle Karim.", "Comment s'appelle le client ?"]);

  const other = await restarted.chat({ message: "Et moi ?", conversationId: first.conversationId, userId: "omar" });
  assert.notEqual(other.conversationId, first.conversationId);
  assert.deepEqual(inputs.at(-1), ["Et moi ?"]);
});

test("an id that is not a conversation id never becomes a path", async () => {
  const store = createFileConversationStore({ dir: join(tmpdir(), "hkids-never-written") });
  assert.equal(await store.get("../../.env"), null);
  await store.save("../evil", { items: [] });
  await assert.rejects(readdir(join(tmpdir(), "hkids-never-written")), { code: "ENOENT" });
});
