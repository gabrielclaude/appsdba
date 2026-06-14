import { NextResponse } from "next/server";
import { query } from "@/lib/db-pg";

export interface ProgramRun {
  request_id: number;
  run_date: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_seconds: number;
  status_desc: string | null;
  is_error: boolean;
  sql_ids: string[];
  plan_hash_values: string[];
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await context.params;
    const programName = decodeURIComponent(name);

    const rows = await query<ProgramRun>(
      `
      WITH runs AS (
        SELECT
          f.request_id,
          f.start_ts,
          f.end_ts,
          ROUND(f.duration_seconds::NUMERIC, 1) AS duration_seconds,
          s.status_desc,
          s.is_error
        FROM fact_concurrent_requests f
        JOIN dim_concurrent_program p ON f.program_sk = p.program_sk
        JOIN dim_request_status     s ON f.status_sk  = s.status_sk
        WHERE p.short_name = $1
          AND f.duration_seconds > 0
        ORDER BY f.start_ts DESC
        LIMIT 10
      ),
      sql_links AS (
        -- Preferred: direct ASH-linked rows (request_id populated by ETL)
        SELECT r.request_id, sp.sql_id, sp.plan_hash_value
        FROM runs r
        JOIN fact_sql_performance sp ON sp.request_id = r.request_id

        UNION

        -- Fallback: correlate by snapshot time overlap when request_id is NULL
        SELECT r.request_id, sp.sql_id, sp.plan_hash_value
        FROM runs r
        JOIN dim_snapshot       ds ON ds.begin_interval_ts <= r.end_ts
                                  AND ds.end_interval_ts   >= r.start_ts
        JOIN fact_sql_performance sp ON sp.snapshot_sk = ds.snapshot_sk
        WHERE sp.request_id IS NULL
          AND r.start_ts    IS NOT NULL
          AND r.end_ts      IS NOT NULL
      )
      SELECT
        r.request_id,
        TO_CHAR(r.start_ts, 'YYYY-MM-DD')    AS run_date,
        TO_CHAR(r.start_ts, 'HH24:MI:SS')    AS start_time,
        TO_CHAR(r.end_ts,   'HH24:MI:SS')    AS end_time,
        r.duration_seconds,
        r.status_desc,
        r.is_error,
        COALESCE(
          ARRAY_AGG(DISTINCT sl.sql_id ORDER BY sl.sql_id)
            FILTER (WHERE sl.sql_id IS NOT NULL),
          '{}'
        ) AS sql_ids,
        COALESCE(
          ARRAY_AGG(DISTINCT sl.plan_hash_value::TEXT ORDER BY sl.plan_hash_value::TEXT)
            FILTER (WHERE sl.plan_hash_value IS NOT NULL),
          '{}'
        ) AS plan_hash_values
      FROM runs r
      LEFT JOIN sql_links sl ON sl.request_id = r.request_id
      GROUP BY
        r.request_id, r.start_ts, r.end_ts,
        r.duration_seconds, r.status_desc, r.is_error
      ORDER BY r.start_ts DESC
      `,
      [programName]
    );

    return NextResponse.json({ success: true, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
