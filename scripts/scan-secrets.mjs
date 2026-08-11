import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { listJavaScriptFiles } from "./list-js-files.mjs";

const patterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/,
  /(api[_-]?key|password|token|secret)\s*[:=]\s*["'][^"']{8,}["']/i
];

const files = [
  ...(await listJavaScriptFiles()),
  "package.json",
  "docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md",
  "docs/AGENT-MVP-BOUNDARIES.md"
];

const findings = [];

for (const file of files) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }

  for (const pattern of patterns) {
    if (pattern.test(text)) {
      findings.push(relative(process.cwd(), file));
      break;
    }
  }
}

if (findings.length > 0) {
  console.error(`Potential hardcoded secrets found in: ${findings.join(", ")}`);
  process.exit(1);
}

console.log("No hardcoded secrets matched the Phase 0 scan patterns.");
