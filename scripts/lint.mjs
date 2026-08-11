import { spawnSync } from "node:child_process";
import { listJavaScriptFiles } from "./list-js-files.mjs";

const files = await listJavaScriptFiles();
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
