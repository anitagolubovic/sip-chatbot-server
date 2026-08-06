import "dotenv/config";
import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { closePool, getPool, withTransaction } from "./pool";
import { isDefined } from "../helper";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "db", "migrations");

type MigrationFile = {
  name: string;
  sql: string;
  contentHash: string;
};

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
      return {
        name,
        sql,
        contentHash: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name          TEXT PRIMARY KEY,
      content_hash  TEXT        NOT NULL,
      applied_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();

  const appliedHashes = new Map<string, string>();
  const rows = await getPool().query<{ name: string; content_hash: string }>(
    "SELECT name, content_hash FROM schema_migrations",
  );
  rows.rows.forEach((row) => appliedHashes.set(row.name, row.content_hash));

  const migrations = loadMigrations();
  let executed = 0;

  for (const migration of migrations) {
    const appliedHash = appliedHashes.get(migration.name);

    if (isDefined(appliedHash)) {
      if (appliedHash !== migration.contentHash) {
        throw new Error(
          `Migration ${migration.name} is changed ` +
            "Create a new migration instead of modifying an existing one.",
        );
      }
      continue;
    }

    await withTransaction(async (client) => {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (name, content_hash) VALUES ($1, $2)",
        [migration.name, migration.contentHash],
      );
    });

    executed += 1;
  }

  if (executed === 0) {
    console.log("Database is already up to date, no new migrations to apply.");
  }
}

if (require.main === module) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error("Migration failed:", error);
      await closePool();
      process.exit(1);
    });
}
