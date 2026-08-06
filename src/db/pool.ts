import "dotenv/config";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { isDefined, isNotDefined } from "../helper";
import { Maybe } from "../models/types";

let pool: Maybe<Pool> = null;

function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (isNotDefined(url)) {
    throw new Error(
      "DATABASE_URL environment variable is required (npr. postgres://sip:sip@localhost:5432/sip_chatbot).",
    );
  }
  return url;
}

export function getPool(): Pool {
  if (isNotDefined(pool)) {
    pool = new Pool({
      connectionString: getConnectionString(),
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (error) => {
      console.error("Connection error", error);
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: any = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (isDefined(pool)) {
    await pool.end();
    pool = null;
  }
}
