import { createInterface } from "node:readline";
import { USER_ROLES, normalizeUserRole } from "../src/security/authorization.js";
import { hashPassword } from "../src/security/password.js";
import { readHiddenLine } from "../src/security/hidden-input.js";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";
import { createRepository } from "../src/persistence/repository-factory.js";
import { assertSeatAvailable, planFromEnv } from "../src/company/plans.js";

// Creates a person who signs in to the hosted cockpit, or changes their
// password. The password is typed at the prompt, never passed on the command
// line, so it does not end up in the shell history.
//
//   npm run auth:create-user -- --id=hiba --name="Hiba" --email=hiba@exemple.ma --role=leader [--provisoire]
//
// With --provisoire the password is a temporary one, given by voice: at the
// first sign-in the cockpit asks the person to choose their own, and opens
// nothing else until they have.
//
// The account belongs to the company of this server (HKIDS_COMPANY_ID, hkids
// by default) unless --company says otherwise; a server refuses the accounts
// of another company. Only a leader sees salaries and confidential expenses.
loadDotEnvIfPresent();

function readOption(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

// Reads a line with nothing echoed when a terminal is attached (key by key, see
// hidden-input.js); piped input is read as is, which is how a deployment
// script can supply it.
async function askHidden(question) {
  if (process.stdin.isTTY) {
    const answer = await readHiddenLine(question);
    if (answer === null) {
      console.error("Interrompu. Rien n'a été modifié.");
      process.exit(130);
    }
    return answer;
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const id = readOption("id");
const email = readOption("email");
const name = readOption("name", id);
const role = normalizeUserRole(readOption("role", "leader"));
const temporary = process.argv.includes("--provisoire");
const companyId = (readOption("company", process.env.HKIDS_COMPANY_ID?.trim() || "hkids") ?? "").trim();

if (!id || !email || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(companyId)) {
  console.error("Usage: npm run auth:create-user -- --id=<id> --email=<email> [--name=<nom affiché>] [--role=<rôle>] [--company=<société>] [--provisoire]");
  console.error(`Rôles : ${USER_ROLES.join(", ")}`);
  process.exit(1);
}

const password = await askHidden("Mot de passe : ");
if (process.stdin.isTTY && (await askHidden("Confirmez le mot de passe : ")) !== password) {
  console.error("Les deux mots de passe sont différents. Rien n'a été modifié.");
  process.exit(1);
}
const passwordHash = await hashPassword(password).catch((error) => {
  console.error(error.message);
  process.exit(1);
});

const repository = await createRepository();
try {
  // A subscription counts its users (HKIDS_PLAN): a new person past the
  // number is refused, an existing account can always be changed.
  const refused = await assertSeatAvailable(repository, { userId: id, plan: planFromEnv() }).then(() => null, (error) => error);
  if (refused) {
    console.error(refused.message);
    process.exitCode = 1;
  } else {
    const existing = await repository.getUser(id);
    const { mustChangePassword: _previous, ...kept } = existing?.metadata ?? {};
    const metadata = { ...kept, companyId, ...(temporary ? { mustChangePassword: true } : {}) };
    const user = await repository.upsertUser({ id, name, email: email.trim().toLowerCase(), role, status: "active", metadata });
    await repository.setUserPassword(user.id, passwordHash);
    console.log(`Compte prêt : ${user.name} <${user.email}> (rôle ${user.role}, société ${companyId}).`);
    if (temporary) {
      console.log("Mot de passe provisoire : à la première connexion, le cockpit demandera d'en choisir un autre.");
    }
  }
} finally {
  await repository.disconnect();
}
