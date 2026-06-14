"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ProgramStat } from "@/app/api/dw/programs/route";
import type { ProgramRun } from "@/app/api/dw/programs/[name]/route";
import type { AnomalyRow } from "@/app/api/dw/anomalies/route";

type Tab = "programs" | "anomalies";
type EtlState = "idle" | "running" | "done" | "error";

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(2)}h`;
}

export default function DWPage() {
  const [tab, setTab] = useState<Tab>("programs");

  const [programs, setPrograms]         = useState<ProgramStat[]>([]);
  const [anomalies, setAnomalies]       = useState<AnomalyRow[]>([]);
  const [loadingProg, setLoadingProg]   = useState(false);
  const [loadingAnom, setLoadingAnom]   = useState(false);
  const [errorProg, setErrorProg]       = useState<string | null>(null);
  const [errorAnom, setErrorAnom]       = useState<string | null>(null);
  const [search, setSearch]             = useState("");

  const [selectedProgram, setSelectedProgram] = useState<string | null>(null);
  const [programRuns, setProgramRuns]         = useState<ProgramRun[]>([]);
  const [loadingRuns, setLoadingRuns]         = useState(false);
  const [errorRuns, setErrorRuns]             = useState<string | null>(null);

  const [etlState, setEtlState]   = useState<EtlState>("idle");
  const [etlLog, setEtlLog]       = useState("");
  const [showLog, setShowLog]     = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  async function runEtl() {
    setEtlState("running");
    setEtlLog("");
    setShowLog(true);
    try {
      const res = await fetch("/api/etl/run", { method: "POST" });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) {
          setEtlLog((prev) => {
            const next = prev + dec.decode(value);
            setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 0);
            return next;
          });
        }
      }
      setEtlState(res.ok ? "done" : "error");
    } catch (e) {
      setEtlLog((prev) => prev + `\n[error] ${String(e)}`);
      setEtlState("error");
    }
  }

  function refreshData() {
    setLoadingProg(true);
    fetch("/api/dw/programs")
      .then((r) => r.json())
      .then((d) => { if (d.success) setPrograms(d.rows); else setErrorProg(d.error); })
      .catch((e) => setErrorProg(String(e)))
      .finally(() => setLoadingProg(false));
    setLoadingAnom(true);
    fetch("/api/dw/anomalies")
      .then((r) => r.json())
      .then((d) => { if (d.success) setAnomalies(d.rows); else setErrorAnom(d.error); })
      .catch((e) => setErrorAnom(String(e)))
      .finally(() => setLoadingAnom(false));
  }

  useEffect(() => { refreshData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedProgram) return;
    setLoadingRuns(true);
    setErrorRuns(null);
    setProgramRuns([]);
    fetch(`/api/dw/programs/${encodeURIComponent(selectedProgram)}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setProgramRuns(d.rows); else setErrorRuns(d.error); })
      .catch((e) => setErrorRuns(String(e)))
      .finally(() => setLoadingRuns(false));
  }, [selectedProgram]);

  const filteredPrograms = programs.filter((r) =>
    [r.short_name, r.user_name, r.application_short_name].join(" ").toLowerCase().includes(search.toLowerCase())
  );
  const filteredAnomalies = anomalies.filter((r) =>
    r.short_name.toLowerCase().includes(search.toLowerCase())
  );

  const tabCls = (t: Tab) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition ${
      tab === t ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
    }`;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link href="/posts/" className="text-xs text-gray-400 hover:text-gray-600 transition">
              ← Blog
            </Link>
            <Link
              href="/posts/ebs-concurrent-program-performance-data-warehouse-python-ml"
              className="text-xs text-emerald-600 hover:text-emerald-800 transition"
            >
              How this was built →
            </Link>
          </div>
          <h1 className="text-2xl font-bold">Performance Data Warehouse</h1>
          <p className="text-sm text-gray-500">Aggregated from PostgreSQL DW — populated by the Python ETL pipeline</p>
        </div>
        <div className="flex flex-col items-end gap-2 ml-4 shrink-0">
          <button
            onClick={runEtl}
            disabled={etlState === "running"}
            className="px-4 py-2 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2"
          >
            {etlState === "running" ? (
              <><span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" /> Running ETL…</>
            ) : "▶ Run ETL"}
          </button>
          {(etlState === "done" || etlState === "error") && (
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium ${etlState === "done" ? "text-emerald-600" : "text-red-600"}`}>
                {etlState === "done" ? "ETL complete" : "ETL failed"}
              </span>
              <button onClick={refreshData} className="text-xs text-blue-600 hover:underline">Refresh data</button>
              <button onClick={() => setShowLog((v) => !v)} className="text-xs text-gray-400 hover:text-gray-600">
                {showLog ? "Hide log" : "Show log"}
              </button>
            </div>
          )}
        </div>
      </div>

      {showLog && etlLog && (
        <pre
          ref={logRef}
          className="mb-4 p-3 bg-gray-900 text-green-400 text-xs rounded-lg overflow-auto max-h-48 font-mono whitespace-pre-wrap"
        >
          {etlLog}
        </pre>
      )}

      <div className="flex gap-0 border-b mb-4">
        <button className={tabCls("programs")}  onClick={() => setTab("programs")}>
          Programs ({programs.length})
        </button>
        <button className={tabCls("anomalies")} onClick={() => setTab("anomalies")}>
          Anomalies ({anomalies.length})
        </button>
      </div>

      <div className="mb-4 flex items-center gap-4">
        <input
          type="text"
          placeholder="Search program name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <span className="text-sm text-gray-400">
          {tab === "programs" ? filteredPrograms.length : filteredAnomalies.length} rows
        </span>
      </div>

      {tab === "programs" && (
        <>
          {errorProg && <ErrorBox msg={errorProg} />}
          {loadingProg ? (
            <p className="text-gray-500 text-sm">Loading…</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2">Program</th>
                    <th className="px-3 py-2">App</th>
                    <th className="px-3 py-2 text-right">Runs</th>
                    <th className="px-3 py-2 text-right">Avg</th>
                    <th className="px-3 py-2 text-right">P95</th>
                    <th className="px-3 py-2 text-right">Max</th>
                    <th className="px-3 py-2 text-right">Error %</th>
                    <th className="px-3 py-2">Last Run</th>
                    <th className="px-3 py-2 text-right">Last Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {filteredPrograms.map((r) => (
                    <tr
                      key={r.short_name}
                      className={`hover:bg-gray-50 ${selectedProgram === r.short_name ? "bg-blue-50" : ""}`}
                    >
                      <td className="px-3 py-2">
                        <button
                          onClick={() =>
                            setSelectedProgram(
                              selectedProgram === r.short_name ? null : r.short_name
                            )
                          }
                          className="font-mono text-xs text-blue-700 hover:underline text-left"
                        >
                          {r.short_name}
                        </button>
                        <div className="text-xs text-gray-400 truncate max-w-xs" title={r.user_name ?? ""}>{r.user_name}</div>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">{r.application_short_name ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{r.run_count.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtDuration(r.avg_duration_sec)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtDuration(r.p95_duration_sec)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtDuration(r.max_duration_sec)}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                          r.error_pct > 20 ? "bg-red-100 text-red-700"
                          : r.error_pct > 5  ? "bg-orange-100 text-orange-700"
                          : "bg-green-50 text-green-700"
                        }`}>
                          {r.error_pct}%
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono whitespace-nowrap text-gray-500">{r.last_run ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtDuration(r.last_duration_sec)}</td>
                    </tr>
                  ))}
                  {filteredPrograms.length === 0 && <EmptyRow cols={9} />}
                </tbody>
              </table>
            </div>
          )}

          {selectedProgram && (
            <div className="mt-4 rounded-lg border border-blue-200 bg-white">
              <div className="flex items-center justify-between px-4 py-3 border-b border-blue-100 bg-blue-50 rounded-t-lg">
                <h2 className="text-sm font-semibold text-blue-800 font-mono">
                  {selectedProgram} — Last 10 Runs
                </h2>
                <button
                  onClick={() => setSelectedProgram(null)}
                  className="text-blue-400 hover:text-blue-700 text-lg leading-none"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {errorRuns && <div className="p-4"><ErrorBox msg={errorRuns} /></div>}

              {loadingRuns ? (
                <p className="px-4 py-6 text-sm text-gray-400">Loading…</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-gray-50 text-left font-semibold text-gray-500 uppercase tracking-wide">
                      <tr>
                        <th className="px-3 py-2">Req ID</th>
                        <th className="px-3 py-2">Run Date</th>
                        <th className="px-3 py-2">Start</th>
                        <th className="px-3 py-2">End</th>
                        <th className="px-3 py-2 text-right">Duration</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">SQL IDs</th>
                        <th className="px-3 py-2">Plan Hash Values</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {programRuns.map((run) => (
                        <tr key={run.request_id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono text-gray-400">{run.request_id}</td>
                          <td className="px-3 py-2 font-mono whitespace-nowrap">{run.run_date ?? "—"}</td>
                          <td className="px-3 py-2 font-mono whitespace-nowrap">{run.start_time ?? "—"}</td>
                          <td className="px-3 py-2 font-mono whitespace-nowrap">{run.end_time ?? "—"}</td>
                          <td className="px-3 py-2 text-right font-mono font-semibold">
                            {fmtDuration(run.duration_seconds)}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                              run.is_error
                                ? "bg-red-100 text-red-700"
                                : "bg-green-50 text-green-700"
                            }`}>
                              {run.status_desc ?? "—"}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-gray-600 max-w-xs">
                            {run.sql_ids.length === 0
                              ? <span className="text-gray-300">—</span>
                              : run.sql_ids.map((id) => (
                                  <span key={id} className="inline-block mr-1 mb-0.5 px-1 bg-gray-100 rounded text-gray-700">{id}</span>
                                ))
                            }
                          </td>
                          <td className="px-3 py-2 font-mono text-gray-600 max-w-xs">
                            {run.plan_hash_values.length === 0
                              ? <span className="text-gray-300">—</span>
                              : run.plan_hash_values.map((phv) => (
                                  <span key={phv} className="inline-block mr-1 mb-0.5 px-1 bg-purple-50 rounded text-purple-700">{phv}</span>
                                ))
                            }
                          </td>
                        </tr>
                      ))}
                      {programRuns.length === 0 && !loadingRuns && <EmptyRow cols={8} />}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === "anomalies" && (
        <>
          {errorAnom && <ErrorBox msg={errorAnom} />}
          {loadingAnom ? (
            <p className="text-gray-500 text-sm">Loading…</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2">Req ID</th>
                    <th className="px-3 py-2">Program</th>
                    <th className="px-3 py-2 text-right">Duration</th>
                    <th className="px-3 py-2 text-right">Program Avg</th>
                    <th className="px-3 py-2 text-right">Z-Score</th>
                    <th className="px-3 py-2">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {filteredAnomalies.map((r) => (
                    <tr key={r.request_id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">{r.request_id}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.short_name}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-red-700 font-semibold">
                        {fmtDuration(r.duration_seconds)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                        {fmtDuration(r.avg_duration)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                          {r.z_score}σ
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono whitespace-nowrap text-gray-500">{r.start_ts ?? "—"}</td>
                    </tr>
                  ))}
                  {filteredAnomalies.length === 0 && <EmptyRow cols={6} />}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="mb-4 p-3 bg-red-50 border border-red-300 text-red-800 rounded text-sm font-mono">
      {msg}
    </div>
  );
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-8 text-center text-gray-400 text-sm">No data</td>
    </tr>
  );
}
