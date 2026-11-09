import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./json-book.js";

// Where the proofs of payment are kept: the photo of a receipt, a supplier's
// invoice as PDF. One file each under data/justificatifs/ (ignored by git),
// named by an id the cash book holds; memory for a test.

export const DEFAULT_RECEIPTS_DIR = join(DATA_DIR, "justificatifs");

export function createMemoryReceiptStore() {
  const files = new Map();
  return Object.freeze({
    async put(id, bytes) {
      files.set(id, Buffer.from(bytes));
    },
    async get(id) {
      return files.has(id) ? Buffer.from(files.get(id)) : null;
    }
  });
}

export function createFileReceiptStore({ dir = DEFAULT_RECEIPTS_DIR } = {}) {
  // The id is made by the cash book (a UUID and an extension); anything else
  // never reaches the disk.
  const path = (id) => {
    if (!/^[0-9a-f-]{36}\.(jpg|png|pdf)$/.test(id)) {
      throw new Error("Invalid receipt id.");
    }
    return join(dir, id);
  };
  return Object.freeze({
    async put(id, bytes) {
      await mkdir(dir, { recursive: true });
      const temporary = `${path(id)}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, path(id));
    },
    async get(id) {
      try {
        return await readFile(path(id));
      } catch (error) {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    }
  });
}
