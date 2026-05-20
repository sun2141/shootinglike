import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const databaseUrl =
  process.env["POSTGRES_URL_NON_POOLING"] ||
  process.env["POSTGRES_PRISMA_URL"] ||
  process.env["POSTGRES_URL"] ||
  process.env["DATABASE_URL"] ||
  "postgresql://dummy:dummy@localhost:5432/dummy";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
