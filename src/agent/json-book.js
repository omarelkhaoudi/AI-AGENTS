import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Where the books of the company are kept: one JSON file each under data/
// (ignored by git), like the plans and the workshop book, or memory for a test.
// Changes are applied one at a time, so two requests never overwrite each other,
// and a file is written to a temporary file then renamed, so a crash never
// leaves half a file.

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DATA_DIR = join(PROJECT_ROOT, "data");

export function createMemoryJsonBook(empty) {
  let value = structuredClone(empty);
  return withQueue({
    load: async () => structuredClone(value),
    save: async (next) => {
      value = structuredClone(next);
    }
  });
}

export function createFileJsonBook(path, empty) {
  return withQueue({
    load: async () => {
      try {
        return { ...structuredClone(empty), ...JSON.parse(await readFile(path, "utf8")) };
      } catch (error) {
        if (error.code === "ENOENT") {
          return structuredClone(empty);
        }
        throw error;
      }
    },
    save: async (next) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2));
      await rename(temporary, path);
    }
  });
}

function withQueue({ load, save }) {
  let queue = Promise.resolve();
  return Object.freeze({
    load,
    // Reads the book, lets change() modify it, saves it, and returns what
    // change() returned. A change that throws saves nothing.
    change(change) {
      const run = queue.then(async () => {
        const book = await load();
        const outcome = await change(book);
        await save(book);
        return outcome;
      });
      queue = run.catch(() => {});
      return run;
    }
  });
}
