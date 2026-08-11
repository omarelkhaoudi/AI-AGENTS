import { spawnSync } from "node:child_process";
import { listJavaScriptFiles } from "./list-js-files.mjs";

const files = await listJavaScriptFiles();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("Build validation completed. No compile step is required for the dependency-free Node foundation.");
