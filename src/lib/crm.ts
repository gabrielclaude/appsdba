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
  { key: 'organic',           label: 'Organic Search'         },
  { key: 'referral',          label: 'Referral'               },
  { key: 'social',            label: 'Social Media'           },
  { key: 'conference',        label: 'Conference'             },
  { key: 'cold-outreach',     label: 'Cold Outreach'          },
  { key: 'oracle-community',  label: 'Oracle Community Forum' },
  { key: 'oaug-quest',        label: 'OAUG / Quest Community' },
  { key: 'zoominfo',          label: 'ZoomInfo'               },
  { key: 'apollo',            label: 'Apollo.io'              },
  { key: 'linkedin-abm',      label: 'LinkedIn ABM'           },
  { key: 'stack-overflow',    label: 'Stack Overflow'         },
  { key: 'other',             label: 'Other'                  },
] as const;

export const ABM_SEGMENTS = [
  { key: 'apps-dba',      label: 'Apps DBA',        color: 'bg-indigo-100 text-indigo-700'  },
  { key: 'ebs-engineer',  label: 'EBS Engineer',    color: 'bg-blue-100 text-blue-700'      },
  { key: 'ebs-manager',   label: 'EBS Manager',     color: 'bg-violet-100 text-violet-700'  },
  { key: 'functional',    label: 'Functional Lead',  color: 'bg-teal-100 text-teal-700'      },
  { key: 'it-director',   label: 'IT Director',     color: 'bg-amber-100 text-amber-700'    },
  { key: 'ebs-onprem',    label: 'On-Prem',         color: 'bg-gray-100 text-gray-700'      },
  { key: 'ebs-cloud',     label: 'Cloud (OCI/AWS)', color: 'bg-cyan-100 text-cyan-700'      },
] as const;

export const ABM_VERTICALS = [
  { key: 'manufacturing', label: 'Manufacturing'    },
  { key: 'healthcare',    label: 'Healthcare'       },
  { key: 'retail',        label: 'Retail/Wholesale' },
  { key: 'energy',        label: 'Energy/Utilities' },
  { key: 'government',    label: 'Government'       },
  { key: 'financial',     label: 'Financial Svcs'   },
  { key: 'education',     label: 'Higher Ed'        },
  { key: 'other',         label: 'Other'            },
] as const;

export function getSegment(key: string) {
  return ABM_SEGMENTS.find((s) => s.key === key) ?? null;
}

export function getVertical(key: string) {
  return ABM_VERTICALS.find((v) => v.key === key) ?? null;
}

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

export async function getAllProspects(stage?: string, segment?: string) {
  const conditions = [];
  if (stage) conditions.push(eq(crmProspects.stage, stage));
  if (segment) conditions.push(sql`${crmProspects.tags}::jsonb @> ${JSON.stringify([segment])}::jsonb`);

  const rows = await db
    .select()
    .from(crmProspects)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
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

export async function getAccountsView(vertical?: string) {
  const all = await db
    .select()
    .from(crmProspects)
    .orderBy(crmProspects.company, desc(crmProspects.createdAt));

  type AccountEntry = {
    company: string;
    vertical: string | null;
    prospects: (typeof all)[number][];
  };

  const map = new Map<string, AccountEntry>();
  for (const p of all) {
    const key = p.company?.trim() || '(No Company)';
    if (!map.has(key)) map.set(key, { company: key, vertical: null, prospects: [] });
    const entry = map.get(key)!;
    // Derive vertical from tags
    if (!entry.vertical && Array.isArray(p.tags)) {
      const vt = ABM_VERTICALS.find((v) => (p.tags as string[]).includes(v.key));
      if (vt) entry.vertical = vt.key;
    }
    entry.prospects.push(p);
  }

  const accounts = [...map.values()]
    .filter((a) => !vertical || a.vertical === vertical || (a.prospects.some((p) => Array.isArray(p.tags) && (p.tags as string[]).includes(vertical!))))
    .map((a) => ({
      ...a,
      count: a.prospects.length,
      topScore: Math.max(0, ...a.prospects.map((p) => p.score)),
      segments: [...new Set(
        a.prospects.flatMap((p) => Array.isArray(p.tags) ? (p.tags as string[]).filter((t) => ABM_SEGMENTS.some((s) => s.key === t)) : [])
      )],
      stages: [...new Set(a.prospects.map((p) => p.stage))],
      lastActivity: a.prospects.reduce<Date | null>((best, p) => {
        const d = p.lastContactedAt ?? p.updatedAt;
        return !best || d > best ? d : best;
      }, null),
    }))
    .sort((a, b) => b.topScore - a.topScore || b.count - a.count);

  return accounts;
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
