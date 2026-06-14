import { Pool, QueryResultRow } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;

  const host = process.env.PG_HOST ?? "localhost";
  pool = new Pool({
    host,
    port: Number(process.env.PG_PORT ?? 5433),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: host.includes("neon.tech") ? { rejectUnauthorized: false } : false,
  });

  return pool;
}

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}
