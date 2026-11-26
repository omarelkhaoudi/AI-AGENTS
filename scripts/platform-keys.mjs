import { existsSync, writeFileSync } from "node:fs";
import { generatePortalKeys } from "../src/security/portal-token.js";

// The portal's signing key, made once on the server that runs it:
//   npm run platform:keys -- --out=deploy/platform-signing-key.pem
// The private key goes to that file, readable by this account only, and never
// on screen; the public key is printed, to give each cockpit as PORTAL_PUBLIC_KEY.
// An existing file is never replaced: a new key would lock every cockpit out.
const option = process.argv.find((argument) => argument.startsWith("--out="));
const out = option ? option.slice("--out=".length) : "";
if (!out) {
  console.error("Usage : npm run platform:keys -- --out=<fichier de la clé privée>");
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`${out} existe déjà : rien n'a été remplacé.`);
  process.exit(1);
}
const keys = generatePortalKeys();
writeFileSync(out, keys.privatePem, { mode: 0o600, flag: "wx" });
console.log(`Clé privée enregistrée dans ${out}.`);
console.log(`PORTAL_PUBLIC_KEY=${keys.publicBase64}`);
