import { createInterface } from "node:readline";
import { USER_ROLES, normalizeUserRole } from "../src/security/authorization.js";
import { hashPassword } from "../src/security/password.js";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";
import { createRepository } from "../src/persistence/repository-factory.js";

// Creates a person who signs in to the hosted cockpit, or changes their
// password. The password is typed at the prompt, never passed on the command
// line, so it does not end up in the shell history.
//
//   npm run auth:create-user -- --id=hiba --name="Hiba" --email=hiba@exemple.ma --role=leader
loadDotEnvIfPresent();

function readOption(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

// Reads a line without echoing it when a terminal is attached; piped input is
// read as is, which is how a deployment script can supply it.
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    if (process.stdin.isTTY) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) {
          process.stdout.write(text);
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (process.stdin.isTTY) {
        process.stdout.write("\n");
      }
      resolve(answer);
    });
  });
}

const id = readOption("id");
const email = readOption("email");
const name = readOption("name", id);
const role = normalizeUserRole(readOption("role", "leader"));

if (!id || !email) {
  console.error("Usage: npm run auth:create-user -- --id=<id> --email=<email> [--name=<nom affiché>] [--role=<rôle>]");
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
  const user = await repository.upsertUser({ id, name, email: email.trim().toLowerCase(), role, status: "active" });
  await repository.setUserPassword(user.id, passwordHash);
  console.log(`Compte prêt : ${user.name} <${user.email}> (rôle ${user.role}).`);
} finally {
  await repository.disconnect();
}
