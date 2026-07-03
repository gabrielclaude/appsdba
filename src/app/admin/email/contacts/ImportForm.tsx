'use client';
import { useRef, useState } from 'react';

type ImportResult = {
  imported: number;
  skipped: number;
  errors: string[];
  total: number;
};

export function ImportForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFile(file: File) {
    setFileName(file.name);
    setResult(null);
    setError(null);
    if (inputRef.current) {
      const dt = new DataTransfer();
      dt.items.add(file);
      inputRef.current.files = dt.files;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) { setError('Please select a file first.'); return; }

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/email/contacts/import', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Import failed'); return; }
      setResult(data);
      if (inputRef.current) inputRef.current.value = '';
      setFileName(null);
      // Only auto-reload on a clean import with no row errors
      if (data.errors.length === 0) {
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Import from Spreadsheet</h2>
        <a
          href="/api/admin/email/contacts/template"
          download="contacts_template.xlsx"
          className="text-xs text-orange-600 hover:text-orange-700"
        >
          Download template (.xlsx)
        </a>
      </div>

      <p className="text-xs text-gray-500 mb-4">
        Accepts <span className="font-medium">.csv</span>, <span className="font-medium">.xlsx</span>, or <span className="font-medium">.xls</span>.
        Required column: <span className="font-mono">email</span>. Duplicate emails are skipped.
      </p>
      <div className="mb-4 overflow-x-auto">
        <table className="text-xs text-gray-500 border-collapse w-full">
          <thead>
            <tr className="bg-gray-50">
              {['Company Name', 'Last name , first name', 'Role', 'Notes', 'email *', 'phone'].map(h => (
                <th key={h} className="border border-gray-200 px-2 py-1 font-medium text-left whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-gray-200 px-2 py-1 text-gray-400">Cambria USA</td>
              <td className="border border-gray-200 px-2 py-1 text-gray-400">Armitage, Brad</td>
              <td className="border border-gray-200 px-2 py-1 text-gray-400">Oracle EBS DBA</td>
              <td className="border border-gray-200 px-2 py-1 text-gray-400">Attended Oracle OpenWorld</td>
              <td className="border border-gray-200 px-2 py-1 text-gray-400">brad@example.com</td>
              <td className="border border-gray-200 px-2 py-1 text-gray-400">9528735184</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-1 text-[11px] text-gray-400">
          Company Name → stored as tag · "Last name, First name" auto-split · Role → job title in notes · Phone: #ERROR! values skipped
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) handleFile(f);
          }}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            dragging ? 'border-orange-400 bg-orange-50' : 'border-gray-300 hover:border-orange-300 hover:bg-gray-50'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
          {fileName ? (
            <p className="text-sm font-medium text-orange-600">{fileName}</p>
          ) : (
            <>
              <p className="text-sm text-gray-500">Drag &amp; drop a file here, or <span className="text-orange-600 font-medium">browse</span></p>
              <p className="text-xs text-gray-400 mt-1">CSV, XLSX, or XLS</p>
            </>
          )}
        </div>

        <button
          type="submit"
          disabled={loading || !fileName}
          className="mt-4 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          {loading ? 'Importing…' : 'Import Contacts'}
        </button>
      </form>

      {/* Error modal */}
      {error && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6">
            <h3 className="text-base font-semibold text-red-700 mb-2">Import Error</h3>
            <p className="text-sm text-gray-700 whitespace-pre-wrap break-words mb-6">{error}</p>
            <button
              type="button"
              onClick={() => setError(null)}
              className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Result modal */}
      {result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 max-h-[80vh] flex flex-col">
            <h3 className={`text-base font-semibold mb-3 ${result.errors.length > 0 ? 'text-yellow-700' : 'text-green-700'}`}>
              Import complete
            </h3>
            <div className="flex gap-6 text-sm mb-4">
              <span className="text-green-700"><span className="font-bold">{result.imported}</span> imported</span>
              <span className="text-gray-500"><span className="font-bold">{result.skipped}</span> skipped (duplicates)</span>
              {result.errors.length > 0 && (
                <span className="text-red-600"><span className="font-bold">{result.errors.length}</span> row errors</span>
              )}
            </div>
            {result.errors.length > 0 && (
              <ul className="text-xs text-red-600 space-y-1 overflow-y-auto flex-1 border border-red-100 rounded-lg p-3 bg-red-50 mb-4">
                {result.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
            <button
              type="button"
              onClick={() => { setResult(null); window.location.reload(); }}
              className="mt-auto px-6 py-2 bg-gray-700 hover:bg-gray-800 text-white text-sm font-medium rounded-lg transition-colors self-start"
            >
              OK — refresh contacts
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
