import { NextResponse } from "next/server";
import { query } from "@/lib/db-pg";

export interface ProgramStat {
  short_name: string;
  user_name: string | null;
  application_short_name: string | null;
  run_count: number;
  avg_duration_sec: number;
  p95_duration_sec: number;
  max_duration_sec: number;
  error_pct: number;
  last_run: string | null;
  last_duration_sec: number | null;
}

export async function GET() {
  try {
    const rows = await query<ProgramStat>(`
      WITH last_runs AS (
        SELECT DISTINCT ON (program_sk)
          program_sk,
          ROUND(duration_seconds::NUMERIC, 1) AS last_duration_sec
        FROM fact_concurrent_requests
        WHERE duration_seconds > 0
        ORDER BY program_sk, start_ts DESC
      )
      SELECT
        p.short_name,
        p.user_name,
        p.application_short_name,
        COUNT(*)::INT                                                       AS run_count,
        ROUND(AVG(f.duration_seconds)::NUMERIC, 1)                         AS avg_duration_sec,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP
              (ORDER BY f.duration_seconds)::NUMERIC, 1)                   AS p95_duration_sec,
        ROUND(MAX(f.duration_seconds)::NUMERIC, 1)                         AS max_duration_sec,
        ROUND((AVG(CASE WHEN s.is_error THEN 1.0 ELSE 0.0 END) * 100)
              ::NUMERIC, 2)                                                 AS error_pct,
        TO_CHAR(MAX(f.start_ts), 'YYYY-MM-DD HH24:MI:SS')                  AS last_run,
        lr.last_duration_sec
      FROM fact_concurrent_requests f
      JOIN dim_concurrent_program p ON f.program_sk = p.program_sk
      JOIN dim_request_status     s ON f.status_sk  = s.status_sk
      LEFT JOIN last_runs lr ON lr.program_sk = p.program_sk
      WHERE f.duration_seconds > 0
      GROUP BY p.short_name, p.user_name, p.application_short_name, lr.last_duration_sec
      HAVING COUNT(*) >= 2
      ORDER BY avg_duration_sec DESC
      LIMIT 100
    `);
    return NextResponse.json({ success: true, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
