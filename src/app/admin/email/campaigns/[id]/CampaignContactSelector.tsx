'use client';
import { useState } from 'react';
import type { EmailContact } from '@/db/schema';

function extractCompany(tags: string | null) {
  if (!tags) return '';
  return tags.split(';')[0].trim();
}

const STATUS_BADGE: Record<string, string> = {
  subscribed: 'bg-green-100 text-green-700',
  unsubscribed: 'bg-red-100 text-red-700',
  bounced: 'bg-yellow-100 text-yellow-700',
  complained: 'bg-purple-100 text-purple-700',
};

export function CampaignContactSelector({
  contacts,
  campaignId,
  sendAction,
}: {
  contacts: EmailContact[];
  campaignId: number;
  sendAction: (formData: FormData) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [testState, setTestState] = useState<'idle' | 'sending' | 'ok' | 'err'>('idle');
  const [testMsg, setTestMsg] = useState('');

  const filtered = contacts.filter((c) => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      `${c.firstName ?? ''} ${c.lastName ?? ''}`.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      extractCompany(c.tags).toLowerCase().includes(q)
    );
  });

  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((c) => next.delete(c.id));
      } else {
        filtered.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function sendTest() {
    setTestState('sending');
    setTestMsg('');
    try {
      const res = await fetch('/api/admin/email/send-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestState('err');
        setTestMsg(data.error ?? 'Failed');
      } else {
        setTestState('ok');
        setTestMsg('Sent to gabriel.claude@gmail.com');
      }
    } catch {
      setTestState('err');
      setTestMsg('Network error');
    }
  }

  return (
    <div className="space-y-4">
      {/* Test email row */}
      <div className="flex items-center gap-3 flex-wrap pb-4 border-b border-gray-100">
        <button
          type="button"
          onClick={sendTest}
          disabled={testState === 'sending'}
          className="text-sm px-4 py-1.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {testState === 'sending' ? 'Sending…' : 'Send Test Email'}
        </button>
        <span className="text-xs text-gray-400">→ gabriel.claude@gmail.com</span>
        {testMsg && (
          <span className={`text-xs font-medium ${testState === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
            {testMsg}
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="search"
          placeholder="Search name, email, company…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 w-56"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        >
          <option value="all">All statuses</option>
          <option value="subscribed">Subscribed</option>
          <option value="unsubscribed">Unsubscribed</option>
          <option value="bounced">Bounced</option>
          <option value="complained">Complained</option>
        </select>
        <button type="button" onClick={toggleAll} className="text-xs text-orange-600 hover:text-orange-700">
          {allFilteredSelected ? 'Deselect all' : 'Select all'}
        </button>
        <span className="text-xs text-gray-400">
          {selected.size} of {contacts.length} selected
        </span>
      </div>

      {/* Contact list */}
      <div className="border border-gray-200 rounded-lg overflow-hidden max-h-72 overflow-y-auto">
        <table className="w-full text-sm">
          <tbody>
            {filtered.map((c) => (
              <tr
                key={c.id}
                onClick={() => toggle(c.id)}
                className={`border-b border-gray-50 cursor-pointer transition-colors hover:bg-orange-50/40 ${selected.has(c.id) ? 'bg-orange-50' : ''}`}
              >
                <td className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-orange-500"
                  />
                </td>
                <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">
                  {[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                </td>
                <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">
                  {extractCompany(c.tags) || '—'}
                </td>
                <td className="px-3 py-2 text-gray-600 text-xs">{c.email}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${STATUS_BADGE[c.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {c.status}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-gray-400">
                  No contacts match your filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Send form — hidden inputs carry selected IDs to the server action */}
      <form action={sendAction}>
        {Array.from(selected).map((id) => (
          <input key={id} type="hidden" name="contactId" value={id} />
        ))}
        <button
          type="submit"
          disabled={selected.size === 0}
          className="bg-orange-500 hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          Send to {selected.size} Contact{selected.size !== 1 ? 's' : ''}
        </button>
      </form>
    </div>
  );
}
