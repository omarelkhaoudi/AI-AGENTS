import { existsSync, readFileSync } from "node:fs";

// Node does not read .env on its own, and neither does Prisma 7, which resolves
// prisma.config.js through process.env. Everything that needs configuration from
// a file loads it here: the seed scripts, and the server itself.
//
// This lived under scripts/ and was called by the seed scripts only. The server
// was not calling it, so a .env that set AUTH_MODE, DATABASE_URL or the n8n
// settings was read by npm run db:seed and ignored by npm start. The demo
// session route simply never registered, and the workflow bridge stayed closed,
// with nothing in the logs to say why.
//
// An existing environment variable always wins: a value exported in the shell is
// an explicit choice and must not be overridden by a file.
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
