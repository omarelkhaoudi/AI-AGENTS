import { loadDotEnvIfPresent } from "../src/load-dotenv.js";
import { createRepository } from "../src/persistence/repository-factory.js";

// Turns two-step sign-in off for one account, for the day a phone and its
// recovery codes are both lost. Run on the server by whoever administers it;
// the person then signs in with the password alone and sets it up again.
//
//   npm run auth:reset-2fa -- --id=hiba
loadDotEnvIfPresent();

const prefix = "--id=";
const id = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
if (!id) {
  console.error("Usage: npm run auth:reset-2fa -- --id=<id du compte>");
  process.exit(1);
}

const repository = await createRepository();
try {
  const state = await repository.getTwoFactor(id);
  if (!state) {
    console.error(`Aucun compte avec mot de passe pour « ${id} ». Rien n'a été modifié.`);
    process.exitCode = 1;
  } else if (!state.secret) {
    console.log(`La double authentification n'est pas active pour « ${id} ». Rien à faire.`);
  } else {
    await repository.updateTwoFactor(id, { secret: null, pendingSecret: null, lastStep: null, enabledAt: null, recoveryCodeHashes: [] });
    console.log(`Double authentification désactivée pour « ${id} ». Le mot de passe seul ouvre de nouveau le compte : réactivez-la depuis le cockpit.`);
  }
} finally {
  await repository.disconnect();
}
