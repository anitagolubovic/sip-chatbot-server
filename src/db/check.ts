import "dotenv/config";
import { closePool, query } from "./pool";

async function check(): Promise<void> {
  const [version] = await query<{ version: string }>("SELECT version()");
  console.log(version.version.split(",")[0]);

  const extensions = await query<{ extname: string; extversion: string }>(
    "SELECT extname, extversion FROM pg_extension WHERE extname = ANY($1)",
    [["vector", "pg_trgm", "unaccent"]],
  );
  console.log(
    "Extensions:",
    extensions.map((e) => `${e.extname}@${e.extversion}`).join(", ") || "none",
  );

  const tables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  );
  console.log(
    `Tables (${tables.length}):`,
    tables.map((t) => t.table_name).join(", "),
  );

  const [distance] = await query<{ d: number }>(
    "SELECT ('[1,0,0]'::vector <=> '[0,1,0]'::vector) AS d",
  );
  console.log("pgvector cosine distance (expected 1):", distance.d);
}

check()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("Database check failed:", error);
    await closePool();
    process.exit(1);
  });
