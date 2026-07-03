export const dynamic = 'force-dynamic';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import { emailContacts } from '@/db/schema';
import { getAllContacts, getReferralCounts } from '@/lib/email-marketing';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { ImportForm } from './ImportForm';
import { CompanyListView } from './CompanyListView';
import Link from 'next/link';

async function addContact(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const firstName = formData.get('firstName') as string;
  const lastName = formData.get('lastName') as string;
  const email = formData.get('email') as string;
  const tags = formData.get('tags') as string;
  const notes = formData.get('notes') as string;

  if (!firstName || !lastName || !email) return;

  const referralCode = crypto.randomUUID().slice(0, 8).toUpperCase();

  await db.insert(emailContacts).values({
    firstName,
    lastName,
    email,
    tags: tags || null,
    notes: notes || null,
    referralCode,
    status: 'subscribed',
  });

  revalidatePath('/admin/email/contacts');
}

async function deleteContact(id: number) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');
  await db.delete(emailContacts).where(eq(emailContacts.id, id));
  revalidatePath('/admin/email/contacts');
}

async function updateContactStatus(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');
  const id = parseInt(formData.get('id') as string);
  const status = formData.get('status') as string;
  if (!id || !status) return;
  await db
    .update(emailContacts)
    .set({ status, updatedAt: new Date() })
    .where(eq(emailContacts.id, id));
  revalidatePath('/admin/email/contacts');
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

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const byCompany = view === 'company';

  const [contacts, referralCounts] = await Promise.all([getAllContacts(500), getReferralCounts()]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Email Contacts</h1>
        {/* View toggle */}
        <div className="flex rounded-lg overflow-hidden border border-gray-200 bg-white text-sm">
          <Link
            href="/admin/email/contacts"
            className={`px-4 py-1.5 transition-colors ${!byCompany ? 'bg-orange-500 text-white font-medium' : 'text-gray-600 hover:bg-gray-50'}`}
          >
            All
          </Link>
          <Link
            href="/admin/email/contacts?view=company"
            className={`px-4 py-1.5 transition-colors ${byCompany ? 'bg-orange-500 text-white font-medium' : 'text-gray-600 hover:bg-gray-50'}`}
          >
            By Company
          </Link>
        </div>
      </div>

      {/* Spreadsheet import */}
      <ImportForm />

      {byCompany ? (
        /* ── Company browse view ── */
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            By Company{' '}
            <span className="text-gray-400 font-normal text-sm">({contacts.length} contacts)</span>
          </h2>
          <CompanyListView contacts={contacts} />
        </div>
      ) : (
        <>
          {/* Add Contact form */}
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Contact</h2>
            <form action={addContact} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">First Name *</label>
                <input
                  name="firstName"
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  placeholder="Jane"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Last Name *</label>
                <input
                  name="lastName"
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  placeholder="Smith"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Email *</label>
                <input
                  name="email"
                  type="email"
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  placeholder="jane@example.com"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Tags</label>
                <input
                  name="tags"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  placeholder="oracle, dba, premium"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
                <textarea
                  name="notes"
                  rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  placeholder="Optional notes"
                />
              </div>
              <div className="md:col-span-2">
                <button
                  type="submit"
                  className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Add Contact
                </button>
              </div>
            </form>
          </div>

          {/* Contact list */}
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              All Contacts <span className="text-gray-400 font-normal text-sm">({contacts.length})</span>
            </h2>
            {contacts.length === 0 ? (
              <p className="text-sm text-gray-400">No contacts yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left py-2 text-gray-500">Name</th>
                      <th className="text-left py-2 text-gray-500">Email</th>
                      <th className="text-left py-2 text-gray-500">Status</th>
                      <th className="text-right py-2 text-gray-500">Emails Sent</th>
                      <th className="text-right py-2 text-gray-500">Referrals</th>
                      <th className="text-left py-2 text-gray-500">Referral Code</th>
                      <th className="text-left py-2 text-gray-500">Tags</th>
                      <th className="text-left py-2 text-gray-500">Added</th>
                      <th className="text-left py-2 text-gray-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((contact) => (
                      <tr key={contact.id} className="border-b border-gray-50">
                        <td className="py-2 font-medium text-gray-800">
                          {contact.firstName} {contact.lastName}
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
                        <td className="py-2 text-gray-400 text-xs">
                          {new Date(contact.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-2">
                          <div className="flex items-center gap-2">
                            <form action={updateContactStatus}>
                              <input type="hidden" name="id" value={contact.id} />
                              <select
                                name="status"
                                defaultValue={contact.status}
                                onChange={(e) => {
                                  const form = e.currentTarget.closest('form') as HTMLFormElement;
                                  form?.requestSubmit();
                                }}
                                className="text-xs border border-gray-200 rounded px-1 py-0.5 text-gray-600 focus:outline-none focus:ring-1 focus:ring-orange-400"
                              >
                                <option value="subscribed">subscribed</option>
                                <option value="unsubscribed">unsubscribed</option>
                                <option value="bounced">bounced</option>
                                <option value="complained">complained</option>
                              </select>
                            </form>
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
            )}
          </div>
        </>
      )}
    </div>
  );
}
