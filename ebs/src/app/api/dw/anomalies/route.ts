import { NextResponse } from "next/server";
import { query } from "@/lib/db-pg";

export interface AnomalyRow {
  request_id: number;
  short_name: string;
  duration_seconds: number;
  avg_duration: number;
  z_score: number;
  start_ts: string | null;
}

export async function GET() {
  try {
    // Statistical anomaly: runs whose duration is > 3 std deviations above their program mean.
    // Requires at least 10 historical runs per program to compute a meaningful baseline.
    const rows = await query<AnomalyRow>(`
      WITH program_stats AS (
        SELECT
          program_sk,
          AVG(duration_seconds)    AS avg_duration,
          STDDEV(duration_seconds) AS std_duration,
          COUNT(*)                 AS run_count
        FROM fact_concurrent_requests
        WHERE duration_seconds > 0
        GROUP BY program_sk
        HAVING COUNT(*) >= 10
      )
      SELECT
        f.request_id,
        p.short_name,
        ROUND(f.duration_seconds::NUMERIC, 1)          AS duration_seconds,
        ROUND(ps.avg_duration::NUMERIC, 1)             AS avg_duration,
        ROUND(((f.duration_seconds - ps.avg_duration)
               / NULLIF(ps.std_duration, 0))::NUMERIC, 2) AS z_score,
        TO_CHAR(f.start_ts, 'YYYY-MM-DD HH24:MI:SS')  AS start_ts
      FROM fact_concurrent_requests f
      JOIN dim_concurrent_program p  ON f.program_sk = p.program_sk
      JOIN program_stats          ps ON f.program_sk = ps.program_sk
      WHERE ps.std_duration > 0
        AND f.duration_seconds > ps.avg_duration + 3 * ps.std_duration
      ORDER BY z_score DESC
      LIMIT 200
    `);
    return NextResponse.json({ success: true, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
