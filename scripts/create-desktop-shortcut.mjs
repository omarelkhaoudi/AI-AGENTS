import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { DEFAULT_ARCHIVE_DIR } from "../src/agent/document-register.js";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";

// Puts « H-KIDS Administratif » on the Windows desktop: a shortcut to the
// folder where the cockpit files each client's devis, bons and factures.
//
//   npm run archive:shortcut
//
// The folder is HKIDS_ARCHIVE_DIR when .env sets it, Documents\H-KIDS
// Administratif otherwise. Run again, it only rewrites the same shortcut.
loadDotEnvIfPresent();

if (process.platform !== "win32") {
  console.error("Ce raccourci se crée sous Windows. Ailleurs, ouvrez le dossier directement.");
  process.exit(1);
}

const target = process.env.HKIDS_ARCHIVE_DIR?.trim() || DEFAULT_ARCHIVE_DIR;
mkdirSync(target, { recursive: true });

// The paths go through the environment, never into the command text, so a
// quote or a space in them cannot break it.
const script = [
  "$desktop = [Environment]::GetFolderPath('Desktop')",
  "$link = Join-Path $desktop 'H-KIDS Administratif.lnk'",
  "$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)",
  "$shortcut.TargetPath = $env:HKIDS_SHORTCUT_TARGET",
  "$shortcut.Description = 'Dossiers clients H-KIDS : devis, bons et factures'",
  "$shortcut.Save()",
  "Write-Output $link"
].join("; ");
const link = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
  env: { ...process.env, HKIDS_SHORTCUT_TARGET: target },
  encoding: "utf8"
}).trim();
console.log(`Raccourci créé : ${link}`);
console.log(`Il ouvre : ${target}`);
