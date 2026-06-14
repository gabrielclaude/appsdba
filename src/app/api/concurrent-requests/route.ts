import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export interface ConcurrentRequest {
  REQUEST_ID: number;
  PROGRAM_NAME: string;
  PHASE_CODE: string;
  STATUS_CODE: string;
  REQUESTED_BY: string;
  REQUESTED_START_DATE: string | null;
  ACTUAL_START_DATE: string | null;
  ACTUAL_COMPLETION_DATE: string | null;
  ARGUMENT_TEXT: string | null;
  COMPLETION_TEXT: string | null;
}

export async function GET() {
  try {
    const rows = await query<ConcurrentRequest>(`
      SELECT
        fcr.REQUEST_ID,
        NVL(fcpt.USER_CONCURRENT_PROGRAM_NAME, '(unknown)') AS PROGRAM_NAME,
        fcr.PHASE_CODE,
        fcr.STATUS_CODE,
        NVL(fu.USER_NAME, TO_CHAR(fcr.REQUESTED_BY)) AS REQUESTED_BY,
        TO_CHAR(fcr.REQUESTED_START_DATE, 'YYYY-MM-DD HH24:MI:SS') AS REQUESTED_START_DATE,
        TO_CHAR(fcr.ACTUAL_START_DATE,     'YYYY-MM-DD HH24:MI:SS') AS ACTUAL_START_DATE,
        TO_CHAR(fcr.ACTUAL_COMPLETION_DATE,'YYYY-MM-DD HH24:MI:SS') AS ACTUAL_COMPLETION_DATE,
        fcr.ARGUMENT_TEXT,
        fcr.COMPLETION_TEXT
      FROM FND_CONCURRENT_REQUESTS fcr
      LEFT JOIN FND_CONCURRENT_PROGRAMS_TL fcpt
        ON  fcr.CONCURRENT_PROGRAM_ID = fcpt.CONCURRENT_PROGRAM_ID
        AND fcpt.LANGUAGE = 'US'
      LEFT JOIN FND_USER fu
        ON fcr.REQUESTED_BY = fu.USER_ID
      ORDER BY fcr.REQUEST_ID DESC
      FETCH FIRST 200 ROWS ONLY
    `);
    return NextResponse.json({ success: true, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
