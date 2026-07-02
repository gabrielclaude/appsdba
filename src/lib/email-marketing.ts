import { db } from '@/db';
import { emailContacts, emailCampaigns, emailSends, emailEvents, posts } from '@/db/schema';
import { eq, desc, count, sql, and, gte, inArray } from 'drizzle-orm';

// ─── Contacts ────────────────────────────────────────────────────────────────

export async function getAllContacts(limit = 200) {
  return db.select().from(emailContacts).orderBy(desc(emailContacts.createdAt)).limit(limit);
}

export async function getContactById(id: number) {
  const [contact] = await db.select().from(emailContacts).where(eq(emailContacts.id, id)).limit(1);
  return contact ?? null;
}

export async function getContactStats() {
  const rows = await db
    .select({ status: emailContacts.status, cnt: count() })
    .from(emailContacts)
    .groupBy(emailContacts.status);

  const map: Record<string, number> = {};
  for (const r of rows) map[r.status] = Number(r.cnt);

  const total = Object.values(map).reduce((a, b) => a + b, 0);
  return {
    total,
    subscribed: map['subscribed'] ?? 0,
    unsubscribed: map['unsubscribed'] ?? 0,
    bounced: map['bounced'] ?? 0,
  };
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

export async function getAllCampaigns(limit = 100) {
  return db.select().from(emailCampaigns).orderBy(desc(emailCampaigns.createdAt)).limit(limit);
}

export async function getCampaignById(id: number) {
  const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, id)).limit(1);
  if (!campaign) return null;

  let postTitle: string | null = null;
  if (campaign.postId) {
    const [post] = await db
      .select({ title: posts.title })
      .from(posts)
      .where(eq(posts.id, campaign.postId))
      .limit(1);
    postTitle = post?.title ?? null;
  }
  return { ...campaign, postTitle };
}

export async function getCampaignSends(campaignId: number, limit = 200) {
  return db
    .select({
      send: emailSends,
      contact: emailContacts,
    })
    .from(emailSends)
    .innerJoin(emailContacts, eq(emailSends.contactId, emailContacts.id))
    .where(eq(emailSends.campaignId, campaignId))
    .limit(limit);
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export async function getCampaignAnalytics() {
  const campaigns = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.status, 'sent'))
    .orderBy(desc(emailCampaigns.sentAt))
    .limit(20);

  return campaigns.map((c) => ({
    ...c,
    openRate: c.totalSent > 0 ? (c.totalOpens / c.totalSent) * 100 : 0,
    clickRate: c.totalSent > 0 ? (c.totalClicks / c.totalSent) * 100 : 0,
    unsubscribeRate: c.totalSent > 0 ? (c.totalUnsubscribes / c.totalSent) * 100 : 0,
  }));
}

export async function getTopicAnalytics() {
  const rows = await db
    .select({
      category: emailCampaigns.category,
      total_campaigns: count(),
      total_sent: sql<number>`SUM(${emailCampaigns.totalSent})`,
      total_opens: sql<number>`SUM(${emailCampaigns.totalOpens})`,
      total_clicks: sql<number>`SUM(${emailCampaigns.totalClicks})`,
      avg_open_rate: sql<number>`AVG(CASE WHEN ${emailCampaigns.totalSent} > 0 THEN ${emailCampaigns.totalOpens}::float / ${emailCampaigns.totalSent} ELSE 0 END) * 100`,
      avg_click_rate: sql<number>`AVG(CASE WHEN ${emailCampaigns.totalSent} > 0 THEN ${emailCampaigns.totalClicks}::float / ${emailCampaigns.totalSent} ELSE 0 END) * 100`,
    })
    .from(emailCampaigns)
    .where(and(eq(emailCampaigns.status, 'sent'), sql`${emailCampaigns.category} IS NOT NULL`))
    .groupBy(emailCampaigns.category)
    .orderBy(sql`AVG(CASE WHEN ${emailCampaigns.totalSent} > 0 THEN ${emailCampaigns.totalOpens}::float / ${emailCampaigns.totalSent} ELSE 0 END) DESC`);

  return rows;
}

export async function getMonthlyEmailStats() {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const sends = await db
    .select({
      month: sql<string>`TO_CHAR(${emailSends.createdAt}, 'YYYY-MM')`,
      sent_count: count(),
    })
    .from(emailSends)
    .where(gte(emailSends.createdAt, sixMonthsAgo))
    .groupBy(sql`TO_CHAR(${emailSends.createdAt}, 'YYYY-MM')`)
    .orderBy(sql`TO_CHAR(${emailSends.createdAt}, 'YYYY-MM')`);

  const opens = await db
    .select({
      month: sql<string>`TO_CHAR(${emailEvents.occurredAt}, 'YYYY-MM')`,
      open_count: count(),
    })
    .from(emailEvents)
    .where(
      and(
        eq(emailEvents.eventType, 'open'),
        gte(emailEvents.occurredAt, sixMonthsAgo),
      ),
    )
    .groupBy(sql`TO_CHAR(${emailEvents.occurredAt}, 'YYYY-MM')`)
    .orderBy(sql`TO_CHAR(${emailEvents.occurredAt}, 'YYYY-MM')`);

  const openMap: Record<string, number> = {};
  for (const o of opens) openMap[o.month] = Number(o.open_count);

  return sends.map((s) => ({
    month: s.month,
    sent_count: Number(s.sent_count),
    open_count: openMap[s.month] ?? 0,
  }));
}

export async function getContactReferrals(contactId: number) {
  return db
    .select()
    .from(emailContacts)
    .where(eq(emailContacts.referredById, contactId));
}

export async function getReferralCounts() {
  const rows = await db
    .select({
      referredById: emailContacts.referredById,
      cnt: count(),
    })
    .from(emailContacts)
    .where(sql`${emailContacts.referredById} IS NOT NULL`)
    .groupBy(emailContacts.referredById);

  const map: Record<number, number> = {};
  for (const r of rows) {
    if (r.referredById != null) map[r.referredById] = Number(r.cnt);
  }
  return map;
}
