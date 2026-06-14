"use client";

import { useState } from "react";
import Link from "next/link";

type TestResult =
  | { success: true; rows: Record<string, unknown>[] }
  | { success: false; error: string };

export default function Home() {
  const [result, setResult] = useState<TestResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function testConnection() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/db-test");
      const data = await res.json();
      setResult(data);
    } catch (e) {
      setResult({ success: false, error: String(e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-bold">EBSOLAP — Oracle DB</h1>
      <p className="text-gray-500 text-sm">Database: ebsdb</p>

      <div className="flex flex-col gap-2 w-64">
        <Link href="/concurrent-requests" className="px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 text-center text-sm transition">
          Concurrent Requests →
        </Link>
        <Link href="/dw" className="px-4 py-2 bg-blue-700 text-white rounded-lg hover:bg-blue-600 text-center text-sm transition">
          Performance DW →
        </Link>
      </div>

      <button
        onClick={testConnection}
        disabled={loading}
        className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
      >
        {loading ? "Connecting…" : "Test Connection"}
      </button>

      {result && (
        <div
          className={`w-full max-w-lg rounded-lg p-4 font-mono text-sm whitespace-pre-wrap ${
            result.success
              ? "bg-green-50 border border-green-300 text-green-900"
              : "bg-red-50 border border-red-300 text-red-900"
          }`}
        >
          {JSON.stringify(result, null, 2)}
        </div>
      )}
    </main>
  );
}
