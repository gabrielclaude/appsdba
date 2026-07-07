'use server';

import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db';
import { crmProspects, crmActivities, emailContacts } from '@/db/schema';
import {
  getProspectById,
  getProspectActivities,
  STAGES,
  SOURCES,
  ACTIVITY_TYPES,
  OUTCOMES,
  getStage,
  getSource,
  getActivityType,
} from '@/lib/crm';

export const dynamic = 'force-dynamic';

async function updateProspect(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const id = parseInt(formData.get('id') as string);
  const followUpRaw = formData.get('nextFollowUpAt') as string;

  await db
    .update(crmProspects)
    .set({
      firstName:      (formData.get('firstName') as string).trim() || null,
      lastName:       (formData.get('lastName') as string).trim() || null,
      email:          (formData.get('email') as string).trim().toLowerCase(),
      company:        (formData.get('company') as string).trim() || null,
      jobTitle:       (formData.get('jobTitle') as string).trim() || null,
      phone:          (formData.get('phone') as string).trim() || null,
      source:         (formData.get('source') as string) || 'organic',
      stage:          (formData.get('stage') as string) || 'lead',
      score:          parseInt(formData.get('score') as string) || 0,
      notes:          (formData.get('notes') as string).trim() || null,
      nextFollowUpAt: followUpRaw ? new Date(followUpRaw) : null,
      updatedAt:      new Date(),
    })
    .where(eq(crmProspects.id, id));

  revalidatePath(`/admin/marketing/crm/${id}`);
}

async function addActivity(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const prospectId = parseInt(formData.get('prospectId') as string);
  const body = (formData.get('body') as string).trim();
  if (!body) return;

  await db.insert(crmActivities).values({
    prospectId,
    type:      (formData.get('type') as string) || 'note',
    subject:   (formData.get('subject') as string).trim() || null,
    body,
    outcome:   (formData.get('outcome') as string) || null,
    createdBy: userId,
  });

  // Update lastContactedAt on the prospect
  await db
    .update(crmProspects)
    .set({ lastContactedAt: new Date(), updatedAt: new Date() })
    .where(eq(crmProspects.id, prospectId));

  revalidatePath(`/admin/marketing/crm/${prospectId}`);
}

async function deleteActivity(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const activityId = parseInt(formData.get('activityId') as string);
  const prospectId = parseInt(formData.get('prospectId') as string);

  await db.delete(crmActivities).where(eq(crmActivities.id, activityId));
  revalidatePath(`/admin/marketing/crm/${prospectId}`);
}

async function convertToContact(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const prospectId = parseInt(formData.get('prospectId') as string);
  const prospect = await getProspectById(prospectId);
  if (!prospect) return;

  // Upsert into emailContacts
  const existing = await db
    .select()
    .from(emailContacts)
    .where(eq(emailContacts.email, prospect.email))
    .limit(1);

  let contactId: number;
  if (existing.length > 0) {
    contactId = existing[0].id;
  } else {
    const inserted = await db
      .insert(emailContacts)
      .values({
        firstName: prospect.firstName,
        lastName:  prospect.lastName,
        email:     prospect.email,
        status:    'subscribed',
        notes:     prospect.notes,
        tags:      prospect.company ?? undefined,
      })
      .returning({ id: emailContacts.id });
    contactId = inserted[0].id;
  }

  await db
    .update(crmProspects)
    .set({
      stage:           'converted',
      convertedAt:     new Date(),
      linkedContactId: contactId,
      updatedAt:       new Date(),
    })
    .where(eq(crmProspects.id, prospectId));

  revalidatePath(`/admin/marketing/crm/${prospectId}`);
  revalidatePath('/admin/marketing/crm');
}

async function deleteProspect(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const id = parseInt(formData.get('id') as string);
  await db.delete(crmProspects).where(eq(crmProspects.id, id));
  redirect('/admin/marketing/crm');
}

function ActivityTypeIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    note: '📝', email: '✉️', call: '📞', meeting: '🤝', demo: '🖥️', 'follow-up': '🔔',
  };
  return <span>{icons[type] ?? '📝'}</span>;
}

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return null;
  const styles: Record<string, string> = {
    positive:    'bg-green-100 text-green-700',
    neutral:     'bg-gray-100 text-gray-600',
    negative:    'bg-red-100 text-red-600',
    'no-response': 'bg-amber-100 text-amber-700',
  };
  const labels: Record<string, string> = {
    positive: 'Positive', neutral: 'Neutral', negative: 'Negative', 'no-response': 'No Response',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[outcome] ?? 'bg-gray-100 text-gray-600'}`}>
      {labels[outcome] ?? outcome}
    </span>
  );
}

export default async function ProspectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const prospectId = parseInt(id);
  if (isNaN(prospectId)) notFound();

  const [prospect, activities] = await Promise.all([
    getProspectById(prospectId),
    getProspectActivities(prospectId),
  ]);

  if (!prospect) notFound();

  const stage = getStage(prospect.stage);
  const source = getSource(prospect.source);
  const followUpValue = prospect.nextFollowUpAt
    ? prospect.nextFollowUpAt.toISOString().slice(0, 10)
    : '';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin/marketing/crm" className="text-sm text-gray-400 hover:text-orange-600">
            ← Prospects
          </Link>
          <span className="text-gray-200">/</span>
          <h1 className="text-2xl font-bold text-gray-900">
            {prospect.firstName || prospect.lastName
              ? `${prospect.firstName ?? ''} ${prospect.lastName ?? ''}`.trim()
              : prospect.email}
          </h1>
          <span className={`text-sm font-medium px-3 py-1 rounded-full ${stage.color}`}>
            {stage.label}
          </span>
        </div>

        {prospect.stage !== 'converted' && (
          <form action={convertToContact}>
            <input type="hidden" name="prospectId" value={prospect.id} />
            <button
              type="submit"
              className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              Convert to Email Contact
            </button>
          </form>
        )}
      </div>

      {prospect.stage === 'converted' && prospect.convertedAt && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-3 text-sm text-green-800">
          ✓ Converted to email contact on {prospect.convertedAt.toLocaleDateString()}
          {prospect.linkedContactId && (
            <Link href="/admin/email/contacts" className="ml-2 underline">
              View contact →
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-cols-5 gap-6">
        {/* Left column: profile edit form */}
        <div className="col-span-2 space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Contact Details</h2>
            <form action={updateProspect} className="space-y-3">
              <input type="hidden" name="id" value={prospect.id} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">First Name</label>
                  <input
                    name="firstName" type="text" defaultValue={prospect.firstName ?? ''}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Last Name</label>
                  <input
                    name="lastName" type="text" defaultValue={prospect.lastName ?? ''}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Email</label>
                <input
                  name="email" type="email" required defaultValue={prospect.email}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Company</label>
                <input
                  name="company" type="text" defaultValue={prospect.company ?? ''}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Job Title</label>
                <input
                  name="jobTitle" type="text" defaultValue={prospect.jobTitle ?? ''}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Phone</label>
                <input
                  name="phone" type="tel" defaultValue={prospect.phone ?? ''}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Source</label>
                  <select
                    name="source" defaultValue={prospect.source}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  >
                    {SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Stage</label>
                  <select
                    name="stage" defaultValue={prospect.stage}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  >
                    {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Score (0–100)</label>
                  <input
                    name="score" type="number" min="0" max="100" defaultValue={prospect.score}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Next Follow-up</label>
                  <input
                    name="nextFollowUpAt" type="date" defaultValue={followUpValue}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
                <textarea
                  name="notes" rows={3} defaultValue={prospect.notes ?? ''}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-none"
                />
              </div>
              <button type="submit" className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2 rounded-lg text-sm font-medium">
                Save Changes
              </button>
            </form>
          </div>

          {/* Meta info */}
          <div className="bg-white border border-gray-200 rounded-xl p-6 text-sm space-y-2 text-gray-500">
            <div className="flex justify-between">
              <span>Source</span><span className="text-gray-700 font-medium">{source.label}</span>
            </div>
            <div className="flex justify-between">
              <span>Added</span><span className="text-gray-700">{prospect.createdAt.toLocaleDateString()}</span>
            </div>
            {prospect.lastContactedAt && (
              <div className="flex justify-between">
                <span>Last contact</span><span className="text-gray-700">{prospect.lastContactedAt.toLocaleDateString()}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Activities</span><span className="text-gray-700">{activities.length}</span>
            </div>
          </div>

          {/* Danger zone */}
          <details className="bg-white border border-gray-200 rounded-xl">
            <summary className="px-5 py-3 cursor-pointer text-xs font-medium text-red-500 hover:text-red-700 select-none">
              Danger zone
            </summary>
            <div className="px-5 pb-4 pt-1">
              <form action={deleteProspect}>
                <input type="hidden" name="id" value={prospect.id} />
                <button
                  type="submit"
                  onClick={(e) => { if (!confirm('Delete this prospect and all their activities?')) e.preventDefault(); }}
                  className="w-full bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 py-2 rounded-lg text-sm font-medium"
                >
                  Delete Prospect
                </button>
              </form>
            </div>
          </details>
        </div>

        {/* Right column: activity timeline */}
        <div className="col-span-3 space-y-4">
          {/* Add activity */}
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Log Activity</h2>
            <form action={addActivity} className="space-y-3">
              <input type="hidden" name="prospectId" value={prospect.id} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
                  <select name="type" className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
                    {ACTIVITY_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Outcome</label>
                  <select name="outcome" className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
                    <option value="">— none —</option>
                    {OUTCOMES.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Subject</label>
                <input name="subject" type="text" placeholder="Brief subject line…" className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Notes <span className="text-red-400">*</span></label>
                <textarea name="body" rows={3} required placeholder="What happened? What was discussed?" className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-none" />
              </div>
              <button type="submit" className="bg-orange-500 hover:bg-orange-600 text-white px-5 py-2 rounded-lg text-sm font-medium">
                Log Activity
              </button>
            </form>
          </div>

          {/* Timeline */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700">Activity Timeline</h2>
            </div>

            {activities.length === 0 ? (
              <p className="px-6 py-8 text-sm text-gray-400 text-center">No activities yet — log the first one above.</p>
            ) : (
              <div className="divide-y divide-gray-50">
                {activities.map((a) => {
                  const atype = getActivityType(a.type);
                  return (
                    <div key={a.id} className="px-6 py-4 flex gap-4 group">
                      <div className="w-8 h-8 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center text-base flex-shrink-0 mt-0.5">
                        <ActivityTypeIcon type={a.type} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-gray-800">
                            {a.subject || atype.label}
                          </span>
                          <OutcomeBadge outcome={a.outcome} />
                          <span className="text-xs text-gray-400 ml-auto">
                            {a.createdAt.toLocaleDateString()} {a.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {a.subject && (
                          <p className="text-xs text-gray-400 mt-0.5">{atype.label}</p>
                        )}
                        <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{a.body}</p>
                      </div>
                      <form action={deleteActivity} className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <input type="hidden" name="activityId" value={a.id} />
                        <input type="hidden" name="prospectId" value={prospect.id} />
                        <button type="submit" className="text-gray-300 hover:text-red-400 text-xs mt-1" title="Delete">✕</button>
                      </form>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
