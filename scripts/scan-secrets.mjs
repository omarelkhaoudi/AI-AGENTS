import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listJavaScriptFiles } from "./list-js-files.mjs";

// High-confidence credential formats. A match is always reported.
export const CREDENTIAL_PATTERNS = Object.freeze([
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /xox[abprs]-[A-Za-z0-9-]{20,}/,
  /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/
]);

// Generic `secretName = "value"` assignments. The value is scored before being
// reported, so harmless business identifiers such as `syncToken: "sync-001"`
// are not flagged while real credentials still are.
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|password|passwd|token|credential)[A-Za-z0-9_]*)\s*[:=]\s*["'`]([^"'`\n]*)["'`]/gi;

// Real credentials are long. Short business identifiers are not secrets.
export const MIN_SECRET_LENGTH = 16;

// A value long enough to be a credential even without digits.
const LONG_SECRET_LENGTH = 32;

// Minimum number of distinct characters, to reject repetitive placeholders.
const MIN_DISTINCT_CHARACTERS = 8;

const PLACEHOLDER_HINTS = Object.freeze([
  "example",
  "placeholder",
  "change-me",
  "changeme",
  "your-",
  "your_",
  "dummy",
  "fake",
  "sample",
  "redacted",
  "todo",
  "xxxx"
]);

export function isLikelySecretValue(value) {
  if (typeof value !== "string") {
    return false;
  }

  const candidate = value.trim();
  if (candidate.length < MIN_SECRET_LENGTH) {
    return false;
  }

  // Interpolations and environment lookups are references, not secrets.
  if (candidate.startsWith("process.env") || candidate.includes("${")) {
    return false;
  }

  // Whitespace means prose, not a credential.
  if (/\s/.test(candidate)) {
    return false;
  }

  const normalized = candidate.toLowerCase();
  if (PLACEHOLDER_HINTS.some((hint) => normalized.includes(hint))) {
    return false;
  }

  const hasLetter = /[A-Za-z]/.test(candidate);
  const hasDigit = /[0-9]/.test(candidate);
  if (!hasLetter) {
    return false;
  }
  if (!hasDigit && candidate.length < LONG_SECRET_LENGTH) {
    return false;
  }

  return new Set(candidate).size >= MIN_DISTINCT_CHARACTERS;
}

export function findPotentialSecrets(text) {
  if (typeof text !== "string") {
    return [];
  }

  const findings = [];

  for (const pattern of CREDENTIAL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      findings.push({ kind: "credential_format", name: null, match: match[0] });
    }
  }

  for (const match of text.matchAll(SECRET_ASSIGNMENT_PATTERN)) {
    const [, name, value] = match;
    if (isLikelySecretValue(value)) {
      findings.push({ kind: "secret_assignment", name, match: value });
    }
  }

  return findings;
}

export function containsPotentialSecret(text) {
  return findPotentialSecrets(text).length > 0;
}

export const SCANNED_EXTRA_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  ".env.example",
  "prisma/schema.prisma",
  "docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md",
  "docs/AGENT-MVP-BOUNDARIES.md",
  "docs/POSTGRESQL_SETUP.md"
]);

export async function scanFilesForSecrets(files) {
  const findings = [];

  for (const file of files) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }

    if (containsPotentialSecret(text)) {
      findings.push(relative(process.cwd(), file));
    }
  }

  return findings;
}

export async function runSecretScan() {
  const files = [...(await listJavaScriptFiles()), ...SCANNED_EXTRA_FILES];
  return scanFilesForSecrets(files);
}

function isDirectExecution() {
  return typeof process.argv[1] === "string" &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  const findings = await runSecretScan();

  if (findings.length > 0) {
    console.error(`Potential hardcoded secrets found in: ${findings.join(", ")}`);
    process.exit(1);
  }

  console.log("No hardcoded secrets matched the Phase 0 scan patterns.");
}
