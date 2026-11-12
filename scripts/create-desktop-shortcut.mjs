import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ARCHIVE_DIR } from "../src/agent/document-register.js";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";

// Puts two shortcuts on the Windows desktop, so Hiba never types a command:
//
//   « H-KIDS Cockpit »        takes the latest version, starts the cockpit
//                              and opens it in the browser (scripts\demarrer-hkids.cmd);
//   « H-KIDS Administratif »  opens the folder where each client's devis,
//                              bons and factures are filed.
//
//   npm run archive:shortcut
//
// The folder is HKIDS_ARCHIVE_DIR when .env sets it, Documents\H-KIDS
// Administratif otherwise. Run again, it only rewrites the same shortcuts.
loadDotEnvIfPresent();

if (process.platform !== "win32") {
  console.error("Ces raccourcis se créent sous Windows.");
  process.exit(1);
}

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const archive = process.env.HKIDS_ARCHIVE_DIR?.trim() || DEFAULT_ARCHIVE_DIR;
mkdirSync(archive, { recursive: true });

// The paths go through the environment, never into the command text, so a
// quote or a space in them cannot break it.
function shortcut({ name, target, directory = "", description, icon = "" }) {
  const script = [
    "$link = Join-Path ([Environment]::GetFolderPath('Desktop')) $env:HKIDS_LINK_NAME",
    "$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)",
    "$shortcut.TargetPath = $env:HKIDS_LINK_TARGET",
    "if ($env:HKIDS_LINK_DIR) { $shortcut.WorkingDirectory = $env:HKIDS_LINK_DIR }",
    "if ($env:HKIDS_LINK_ICON) { $shortcut.IconLocation = $env:HKIDS_LINK_ICON }",
    "$shortcut.Description = $env:HKIDS_LINK_DESCRIPTION",
    "$shortcut.Save()",
    "Write-Output $link"
  ].join("; ");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, HKIDS_LINK_NAME: `${name}.lnk`, HKIDS_LINK_TARGET: target, HKIDS_LINK_DIR: directory, HKIDS_LINK_ICON: icon, HKIDS_LINK_DESCRIPTION: description },
    encoding: "utf8"
  }).trim();
}

const cockpit = shortcut({
  name: "H-KIDS Cockpit",
  target: join(project, "scripts", "demarrer-hkids.cmd"),
  directory: project,
  description: "Met à jour et démarre le cockpit H-KIDS, puis l'ouvre dans le navigateur",
  icon: "%SystemRoot%\\System32\\shell32.dll,13"
});
console.log(`Raccourci créé : ${cockpit}`);
console.log("  Double-clic : mise à jour, démarrage et ouverture du cockpit.");

const folder = shortcut({ name: "H-KIDS Administratif", target: archive, description: "Dossiers clients H-KIDS : devis, bons et factures" });
console.log(`Raccourci créé : ${folder}`);
console.log(`  Il ouvre : ${archive}`);
