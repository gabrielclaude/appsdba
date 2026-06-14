"use client";

import { useEffect, useState } from "react";
import type { ConcurrentRequest } from "@/app/api/concurrent-requests/route";

const PHASE: Record<string, string> = { P: "Pending", R: "Running", C: "Completed", I: "Inactive" };
const STATUS: Record<string, string> = {
  // Pending
  I: "Normal", S: "Scheduled", B: "Blocked",
  // Running
  R: "Normal", T: "Terminating",
  // Completed
  C: "Normal", G: "Warning", E: "Error", X: "Terminated",
  // Inactive
  D: "Disabled", H: "On Hold", U: "No Manager", W: "Paused", Z: "Waiting",
};

const PHASE_COLOR: Record<string, string> = {
  P: "bg-yellow-100 text-yellow-800",
  R: "bg-blue-100 text-blue-800",
  C: "bg-green-100 text-green-800",
  I: "bg-gray-100 text-gray-600",
};

const STATUS_COLOR: Record<string, string> = {
  E: "bg-red-100 text-red-800",
  X: "bg-red-100 text-red-800",
  G: "bg-orange-100 text-orange-800",
  C: "bg-green-100 text-green-800",
  R: "bg-blue-100 text-blue-800",
};

export default function ConcurrentRequestsPage() {
  const [rows, setRows] = useState<ConcurrentRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/concurrent-requests")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setRows(data.rows);
        else setError(data.error);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const filtered = rows.filter((r) =>
    [r.PROGRAM_NAME, r.REQUESTED_BY, r.ARGUMENT_TEXT, r.COMPLETION_TEXT]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Concurrent Requests</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-300 text-red-800 rounded text-sm font-mono">
          {error}
        </div>
      )}

      <div className="mb-4 flex items-center gap-4">
        <input
          type="text"
          placeholder="Search program, user, arguments…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm w-80 focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <span className="text-sm text-gray-500">{filtered.length} rows</span>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2">Req ID</th>
                <th className="px-3 py-2">Program</th>
                <th className="px-3 py-2">Phase</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Requested By</th>
                <th className="px-3 py-2">Start</th>
                <th className="px-3 py-2">End</th>
                <th className="px-3 py-2">Arguments</th>
                <th className="px-3 py-2">Completion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {filtered.map((r) => (
                <tr key={r.REQUEST_ID} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs text-gray-500">{r.REQUEST_ID}</td>
                  <td className="px-3 py-2 max-w-xs truncate" title={r.PROGRAM_NAME}>{r.PROGRAM_NAME}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PHASE_COLOR[r.PHASE_CODE] ?? "bg-gray-100 text-gray-600"}`}>
                      {PHASE[r.PHASE_CODE] ?? r.PHASE_CODE}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[r.STATUS_CODE] ?? "bg-gray-100 text-gray-600"}`}>
                      {STATUS[r.STATUS_CODE] ?? r.STATUS_CODE}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.REQUESTED_BY}</td>
                  <td className="px-3 py-2 text-xs font-mono whitespace-nowrap">{r.ACTUAL_START_DATE ?? r.REQUESTED_START_DATE ?? "—"}</td>
                  <td className="px-3 py-2 text-xs font-mono whitespace-nowrap">{r.ACTUAL_COMPLETION_DATE ?? "—"}</td>
                  <td className="px-3 py-2 max-w-xs truncate text-xs text-gray-500" title={r.ARGUMENT_TEXT ?? ""}>{r.ARGUMENT_TEXT ?? "—"}</td>
                  <td className="px-3 py-2 max-w-xs truncate text-xs text-gray-500" title={r.COMPLETION_TEXT ?? ""}>{r.COMPLETION_TEXT ?? "—"}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-gray-400 text-sm">No results</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
