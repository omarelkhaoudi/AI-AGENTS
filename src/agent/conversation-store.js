import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The Director's conversations: what was said, the photos shown and how many
// documents were joined. A conversation belongs to the person who started it;
// another person sending its id starts a conversation of their own.
//
// The server keeps them as one JSON file each under data/conversations/
// (ignored by git), so a restart or a new deployment does not make the Director
// forget what it was told a minute before. A test keeps them in memory.

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_CONVERSATIONS_DIR = join(PROJECT_ROOT, "data", "conversations");
const CONVERSATION_ID = /^[0-9a-f-]{36}$/;

export function createMemoryConversationStore() {
  const conversations = new Map();
  return Object.freeze({
    async get(id) {
      return conversations.get(id) ?? null;
    },
    async save(id, conversation) {
      conversations.set(id, conversation);
    }
  });
}

export function createFileConversationStore({ dir = DEFAULT_CONVERSATIONS_DIR } = {}) {
  // The id comes from the browser: only a UUID is ever turned into a path.
  const pathOf = (id) => (CONVERSATION_ID.test(id) ? join(dir, `${id}.json`) : null);
  return Object.freeze({
    async get(id) {
      const path = pathOf(id);
      if (!path) {
        return null;
      }
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    // Written to a temporary file and renamed, so a crash never leaves half a file.
    async save(id, conversation) {
      const path = pathOf(id);
      if (!path) {
        return;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(conversation));
      await rename(`${path}.tmp`, path);
    }
  });
}
