import { createApiTokenMaterial } from "../src/security/api-token.js";
import { USER_ROLES, normalizeUserRole } from "../src/security/authorization.js";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";
import { createRepository } from "../src/persistence/repository-factory.js";

// Before createRepository reads DATABASE_URL. Without this, a URL living only in
// .env was invisible here: the token was written to an in-memory repository,
// printed, and lost when the process exited. The seed scripts already did this;
// this one did not.
loadDotEnvIfPresent();

function readOption(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const userId = readOption("user-id");
const name = readOption("name", "api-token");
const role = normalizeUserRole(readOption("role", "leader"));
const email = readOption("email");

if (!userId) {
  console.error("Usage: npm run auth:create-token -- --user-id=<id> [--name=<label>] [--role=<role>] [--email=<email>]");
  console.error(`Supported roles: ${USER_ROLES.join(", ")}`);
  process.exit(1);
}

const repository = await createRepository();

try {
  const user = await repository.upsertUser({
    id: userId,
    name: readOption("display-name", userId),
    role,
    status: "active",
    email
  });
  const material = createApiTokenMaterial({ userId: user.id, name });
  await repository.createApiToken(material.record);

  // The secret is shown once and never stored: only its hash is persisted.
  console.log(`user:  ${user.id} (role ${user.role})`);
  console.log(`token: ${material.secret}`);
  console.log("Store it now. It cannot be recovered from the database.");
} finally {
  await repository.disconnect();
}
