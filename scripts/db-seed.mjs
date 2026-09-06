import {
  PrismaRepository,
  createPrismaClient,
  hasValidDatabaseUrl,
  seedMvpAgents
} from "../src/index.js";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";

loadDotEnvIfPresent();

if (!hasValidDatabaseUrl(process.env.DATABASE_URL)) {
  console.error("DATABASE_URL must be a valid PostgreSQL URL before running db:seed.");
  process.exit(1);
}

const prisma = await createPrismaClient();
const repository = new PrismaRepository({ prisma });

try {
  const agents = await seedMvpAgents(repository);
  console.log(`Seeded ${agents.length} MVP agents: ${agents.map((agent) => agent.id).join(", ")}`);
} finally {
  await repository.disconnect();
}
