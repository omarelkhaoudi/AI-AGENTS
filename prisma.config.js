import { defineConfig, env } from "prisma/config";
import { loadDotEnvIfPresent } from "./src/load-dotenv.js";

loadDotEnvIfPresent();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations"
  },
  datasource: {
    url: env("DATABASE_URL")
  }
});
