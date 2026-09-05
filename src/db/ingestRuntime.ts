import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import type { PoolClient } from "pg";
import { closePool, query } from "./pool";
import { isDefined } from "../helper";
import { DATA_DIR } from "../scraper/lib/scraperRuntime";

export type SourceFile<T> = {
  /** Putanja relativna u odnosu na data/, kljuc u tabeli source_files. */
  path: string;
  document: T;
  contentHash: string;
};

export function readSourceFile<T>(file: string): SourceFile<T> {
  const raw = readFileSync(file, "utf8");
  return {
    path: path.relative(DATA_DIR, file).replace(/\\/g, "/"),
    document: JSON.parse(raw) as T,
    contentHash: createHash("sha256").update(raw).digest("hex"),
  };
}

/** Tacan zbir heseva vise fajlova, da se skup rasporeda prati kao jedna celina. */
export function combinedHash(hashes: readonly string[]): string {
  return createHash("sha256")
    .update([...hashes].sort().join("\n"))
    .digest("hex");
}

export async function isUnchanged(
  sourcePath: string,
  contentHash: string,
): Promise<boolean> {
  const [previous] = await query<{ sha256: string }>(
    "SELECT sha256 FROM source_files WHERE path = $1",
    [sourcePath],
  );
  return isDefined(previous) && previous.sha256 === contentHash;
}

export async function recordSourceFile(
  client: PoolClient,
  sourcePath: string,
  contentHash: string,
  recordCount: number,
): Promise<void> {
  await client.query(
    `INSERT INTO source_files (path, sha256, record_count, ingested_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (path) DO UPDATE
       SET sha256 = EXCLUDED.sha256,
           record_count = EXCLUDED.record_count,
           ingested_at = EXCLUDED.ingested_at`,
    [sourcePath, contentHash, recordCount],
  );
}

/** Postgres dopusta najvise 65535 parametara po upitu. */
export function rowsPerBatch(columnCount: number): number {
  return Math.floor(65535 / columnCount / 2);
}

export async function insertRows(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
): Promise<void> {
  const batchSize = rowsPerBatch(columns.length);

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values = batch
      .map(
        (_row, rowIndex) =>
          `(${columns
            .map(
              (_column, columnIndex) =>
                `$${rowIndex * columns.length + columnIndex + 1}`,
            )
            .join(", ")})`,
      )
      .join(", ");

    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}`,
      batch.flat(),
    );
  }
}

export type IngestOptions = { force?: boolean };

export function parseIngestArguments(argv: readonly string[]): {
  academicYear?: string;
  options: IngestOptions;
} {
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  return {
    academicYear: positional[0],
    options: { force: argv.includes("--force") },
  };
}

export function runIngestCli(
  task: () => Promise<void>,
  errorLabel: string,
): void {
  task()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (error: unknown) => {
      console.error(errorLabel, error instanceof Error ? error.message : error);
      await closePool();
      process.exit(1);
    });
}
