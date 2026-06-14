import oracledb from "oracledb";

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let pool: oracledb.Pool | null = null;

export async function getPool(): Promise<oracledb.Pool> {
  if (pool) return pool;

  // Thick mode is required for older Oracle password verifiers (10g-style 0x939)
  // Must be called before createPool; DPI-1047 means already initialized (hot reload).
  try {
    oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_LIB_DIR });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("DPI-1047")) throw err;
  }

  pool = await oracledb.createPool({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECTION_STRING,
    poolMin: 1,
    poolMax: 10,
    poolIncrement: 1,
  });

  return pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  binds: oracledb.BindParameters = [],
  opts: oracledb.ExecuteOptions = {}
): Promise<T[]> {
  const p = await getPool();
  const conn = await p.getConnection();
  try {
    const result = await conn.execute<T>(sql, binds, opts);
    return (result.rows ?? []) as T[];
  } finally {
    await conn.close();
  }
}
