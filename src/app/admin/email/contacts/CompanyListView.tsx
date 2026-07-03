'use client';
import { useState } from 'react';
import type { EmailContact } from '@/db/schema';

function extractCompany(tags: string | null): string {
  if (!tags) return '(No Company)';
  const first = tags.split(';')[0].trim();
  return first || '(No Company)';
}

function extractRoles(tags: string | null): string[] {
  if (!tags) return [];
  const parts = tags.split(';').map(t => t.trim()).filter(Boolean);
  return parts.slice(1); // skip company (first segment)
}

function extractPhone(notes: string | null): string | null {
  if (!notes) return null;
  const m = notes.match(/Phone:\s*([^\s|]+)/);
  return m ? m[1] : null;
}

function extractTitle(notes: string | null): string | null {
  if (!notes) return null;
  return notes.split('|')[0].trim() || null;
}

const STATUS_COLORS: Record<string, string> = {
  subscribed: 'bg-green-100 text-green-700',
  unsubscribed: 'bg-red-100 text-red-700',
  bounced: 'bg-yellow-100 text-yellow-700',
  complained: 'bg-purple-100 text-purple-700',
};

export function CompanyListView({ contacts }: { contacts: EmailContact[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const groups = new Map<string, EmailContact[]>();
  for (const c of contacts) {
    const company = extractCompany(c.tags);
    if (!groups.has(company)) groups.set(company, []);
    groups.get(company)!.push(c);
  }

  const q = search.toLowerCase();
  const sorted = [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === '(No Company)') return 1;
      if (b === '(No Company)') return -1;
      return a.localeCompare(b);
    })
    .filter(([company, members]) => {
      if (!q) return true;
      if (company.toLowerCase().includes(q)) return true;
      return members.some(
        c =>
          `${c.firstName ?? ''} ${c.lastName ?? ''}`.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q),
      );
    });

  function toggle(company: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(company) ? next.delete(company) : next.add(company);
      return next;
    });
  }

  function expandAll() {
    setExpanded(new Set(sorted.map(([c]) => c)));
  }
  function collapseAll() {
    setExpanded(new Set());
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <input
          type="search"
          placeholder="Search company or contact…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
        <button onClick={expandAll} className="text-xs text-gray-500 hover:text-orange-600 whitespace-nowrap">
          Expand all
        </button>
        <button onClick={collapseAll} className="text-xs text-gray-500 hover:text-orange-600 whitespace-nowrap">
          Collapse all
        </button>
        <span className="text-xs text-gray-400 whitespace-nowrap">{sorted.length} companies</span>
      </div>

      {/* Company accordion */}
      {sorted.map(([company, members]) => {
        const isOpen = expanded.has(company);
        const filteredMembers = q
          ? members.filter(
              c =>
                company.toLowerCase().includes(q) ||
                `${c.firstName ?? ''} ${c.lastName ?? ''}`.toLowerCase().includes(q) ||
                c.email.toLowerCase().includes(q),
            )
          : members;

        return (
          <div key={company} className="border border-gray-200 rounded-xl overflow-hidden">
            {/* Company header row */}
            <button
              onClick={() => toggle(company)}
              className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-orange-50 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <span className="font-semibold text-gray-900">{company}</span>
                <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                  {members.length} contact{members.length !== 1 ? 's' : ''}
                </span>
              </div>
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Contact rows */}
            {isOpen && (
              <div className="border-t border-gray-100 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 whitespace-nowrap">Name</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 whitespace-nowrap">Email</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 whitespace-nowrap">Title</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 whitespace-nowrap">Roles / Tags</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 whitespace-nowrap">Phone</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 whitespace-nowrap">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMembers.map(c => {
                      const roles = extractRoles(c.tags);
                      const title = extractTitle(c.notes);
                      const phone = extractPhone(c.notes);
                      return (
                        <tr key={c.id} className="border-t border-gray-50 hover:bg-orange-50/30 transition-colors">
                          <td className="px-4 py-2 font-medium text-gray-900 whitespace-nowrap">
                            {[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                          </td>
                          <td className="px-4 py-2 text-gray-600 whitespace-nowrap">
                            <a href={`mailto:${c.email}`} className="hover:text-orange-600 transition-colors">
                              {c.email}
                            </a>
                          </td>
                          <td className="px-4 py-2 text-gray-500 text-xs max-w-[200px]">{title ?? '—'}</td>
                          <td className="px-4 py-2 max-w-[260px]">
                            {roles.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {roles.map(r => (
                                  <span key={r} className="text-[11px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">
                                    {r}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{phone ?? '—'}</td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-600'}`}
                            >
                              {c.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {sorted.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-8">No companies match your search.</p>
      )}
    </div>
  );
}
