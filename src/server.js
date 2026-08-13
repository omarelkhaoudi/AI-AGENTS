import { buildApi } from "./api/server.js";
import { createRepository } from "./persistence/repository-factory.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";
const repository = await createRepository();
const app = buildApi({ repository });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
