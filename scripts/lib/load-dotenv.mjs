import { existsSync, readFileSync } from "node:fs";

// Prisma 7 resolves prisma.config.js through process.env and no longer reads
// .env on its own, so every script that needs DATABASE_URL loads it here.
// An existing environment variable always wins: a value exported in the shell
// is an explicit choice and must not be overridden by a file.
export function loadDotEnvIfPresent(path = ".env") {
  if (!existsSync(path)) {
    return [];
  }

  const loaded = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = stripQuotes(trimmed.slice(separatorIndex + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }

  return loaded;
}

function stripQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
