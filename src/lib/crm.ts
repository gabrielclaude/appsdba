import { db } from '@/db';
import { crmProspects, crmActivities } from '@/db/schema';
import { eq, desc, lte, sql, and, isNotNull } from 'drizzle-orm';

export const STAGES = [
  { key: 'lead',       label: 'Lead',       color: 'bg-gray-100 text-gray-700',     dot: 'bg-gray-400'   },
  { key: 'qualified',  label: 'Qualified',  color: 'bg-blue-100 text-blue-700',     dot: 'bg-blue-500'   },
  { key: 'interested', label: 'Interested', color: 'bg-amber-100 text-amber-700',   dot: 'bg-amber-500'  },
  { key: 'trial',      label: 'Trial',      color: 'bg-purple-100 text-purple-700', dot: 'bg-purple-500' },
  { key: 'converted',  label: 'Converted',  color: 'bg-green-100 text-green-700',   dot: 'bg-green-500'  },
  { key: 'lost',       label: 'Lost',       color: 'bg-red-100 text-red-700',       dot: 'bg-red-400'    },
] as const;

export const SOURCES = [
  { key: 'organic',       label: 'Organic Search' },
  { key: 'referral',      label: 'Referral'        },
  { key: 'social',        label: 'Social Media'    },
  { key: 'conference',    label: 'Conference'      },
  { key: 'cold-outreach', label: 'Cold Outreach'   },
  { key: 'other',         label: 'Other'           },
] as const;

export const ACTIVITY_TYPES = [
  { key: 'note',      label: 'Note'       },
  { key: 'email',     label: 'Email'      },
  { key: 'call',      label: 'Phone Call' },
  { key: 'meeting',   label: 'Meeting'    },
  { key: 'demo',      label: 'Demo'       },
  { key: 'follow-up', label: 'Follow-up'  },
] as const;

export const OUTCOMES = [
  { key: 'positive',    label: 'Positive'     },
  { key: 'neutral',     label: 'Neutral'      },
  { key: 'negative',    label: 'Negative'     },
  { key: 'no-response', label: 'No Response'  },
] as const;

export function getStage(key: string) {
  return STAGES.find((s) => s.key === key) ?? STAGES[0];
}

export function getSource(key: string) {
  return SOURCES.find((s) => s.key === key) ?? SOURCES[5];
}

export function getActivityType(key: string) {
  return ACTIVITY_TYPES.find((t) => t.key === key) ?? ACTIVITY_TYPES[0];
}

export async function getAllProspects(stage?: string) {
  const rows = await db
    .select()
    .from(crmProspects)
    .where(stage ? eq(crmProspects.stage, stage) : undefined)
    .orderBy(
      sql`CASE stage
        WHEN 'lead'       THEN 1
        WHEN 'qualified'  THEN 2
        WHEN 'interested' THEN 3
        WHEN 'trial'      THEN 4
        WHEN 'converted'  THEN 5
        WHEN 'lost'       THEN 6
        ELSE 7 END`,
      desc(crmProspects.createdAt),
    );
  return rows;
}

export async function getPipelineCounts() {
  const rows = await db
    .select({
      stage: crmProspects.stage,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(crmProspects)
    .groupBy(crmProspects.stage);

  const map: Record<string, number> = {};
  for (const r of rows) map[r.stage] = r.count;
  return map;
}

export async function getFollowUpsDue() {
  const now = new Date();
  return db
    .select()
    .from(crmProspects)
    .where(
      and(
        isNotNull(crmProspects.nextFollowUpAt),
        lte(crmProspects.nextFollowUpAt, now),
        sql`${crmProspects.stage} NOT IN ('converted', 'lost')`,
      ),
    )
    .orderBy(crmProspects.nextFollowUpAt);
}

export async function getProspectById(id: number) {
  const rows = await db
    .select()
    .from(crmProspects)
    .where(eq(crmProspects.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getProspectActivities(prospectId: number) {
  return db
    .select()
    .from(crmActivities)
    .where(eq(crmActivities.prospectId, prospectId))
    .orderBy(desc(crmActivities.createdAt));
}
