import { readdir } from "node:fs/promises";
import { join } from "node:path";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

export async function listJavaScriptFiles(root = process.cwd()) {
  const files = [];
  await walk(root, files);
  return files.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));
}

async function walk(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await walk(join(directory, entry.name), files);
      }
      continue;
    }
    files.push(join(directory, entry.name));
  }
}
