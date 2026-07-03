'use client';
import { useState } from 'react';
import type { EmailContact } from '@/db/schema';
import { StatusSelect } from './StatusSelect';

type SortKey = 'name' | 'company' | 'email' | 'status' | 'emailsSent' | 'referrals' | 'createdAt';

function extractCompany(tags: string | null): string {
  if (!tags) return '';
  return tags.split(';')[0].trim();
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    subscribed: 'bg-green-100 text-green-700',
    unsubscribed: 'bg-red-100 text-red-700',
    bounced: 'bg-yellow-100 text-yellow-700',
    complained: 'bg-purple-100 text-purple-700',
  };
  return colors[status] ?? 'bg-gray-100 text-gray-600';
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const isActive = active === sortKey;
  return (
    <th
      className={`py-2 text-gray-500 cursor-pointer select-none whitespace-nowrap hover:text-gray-800 transition-colors ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <span className="ml-1 text-gray-300">
        {isActive ? (dir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  );
}

export function ContactsTable({
  contacts,
  referralCounts,
  updateContactStatus,
  deleteContact,
}: {
  contacts: EmailContact[];
  referralCounts: Record<number, number>;
  updateContactStatus: (formData: FormData) => Promise<void>;
  deleteContact: (id: number) => Promise<void>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = [...contacts].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'name':
        cmp = `${a.firstName ?? ''} ${a.lastName ?? ''}`.localeCompare(`${b.firstName ?? ''} ${b.lastName ?? ''}`);
        break;
      case 'company':
        cmp = extractCompany(a.tags).localeCompare(extractCompany(b.tags));
        break;
      case 'email':
        cmp = a.email.localeCompare(b.email);
        break;
      case 'status':
        cmp = a.status.localeCompare(b.status);
        break;
      case 'emailsSent':
        cmp = a.emailsSent - b.emailsSent;
        break;
      case 'referrals':
        cmp = (referralCounts[a.id] ?? 0) - (referralCounts[b.id] ?? 0);
        break;
      case 'createdAt':
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sharedProps = { active: sortKey, dir: sortDir, onSort: handleSort };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <SortHeader label="Name" sortKey="name" {...sharedProps} />
            <SortHeader label="Company" sortKey="company" {...sharedProps} />
            <SortHeader label="Email" sortKey="email" {...sharedProps} />
            <SortHeader label="Status" sortKey="status" {...sharedProps} />
            <SortHeader label="Emails Sent" sortKey="emailsSent" {...sharedProps} align="right" />
            <SortHeader label="Referrals" sortKey="referrals" {...sharedProps} align="right" />
            <th className="text-left py-2 text-gray-500 whitespace-nowrap">Referral Code</th>
            <th className="text-left py-2 text-gray-500 whitespace-nowrap">Tags</th>
            <SortHeader label="Added" sortKey="createdAt" {...sharedProps} />
            <th className="text-left py-2 text-gray-500">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((contact) => (
            <tr key={contact.id} className="border-b border-gray-50">
              <td className="py-2 font-medium text-gray-800 whitespace-nowrap">
                {contact.firstName} {contact.lastName}
              </td>
              <td className="py-2 text-gray-600 text-xs whitespace-nowrap">
                {extractCompany(contact.tags) || '—'}
              </td>
              <td className="py-2 text-gray-600">{contact.email}</td>
              <td className="py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusBadge(contact.status)}`}>
                  {contact.status}
                </span>
              </td>
              <td className="py-2 text-right text-gray-600">{contact.emailsSent}</td>
              <td className="py-2 text-right text-gray-600">{referralCounts[contact.id] ?? 0}</td>
              <td className="py-2">
                <span className="font-mono text-xs text-gray-500">{contact.referralCode ?? '—'}</span>
              </td>
              <td className="py-2 text-gray-500 text-xs">{contact.tags ?? '—'}</td>
              <td className="py-2 text-gray-400 text-xs whitespace-nowrap">
                {new Date(contact.createdAt).toLocaleDateString()}
              </td>
              <td className="py-2">
                <div className="flex items-center gap-2">
                  <StatusSelect
                    id={contact.id}
                    status={contact.status}
                    updateAction={updateContactStatus}
                  />
                  <form action={deleteContact.bind(null, contact.id)}>
                    <button
                      type="submit"
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
