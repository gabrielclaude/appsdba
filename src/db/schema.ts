import { pgTable, serial, text, varchar, timestamp, boolean, pgEnum, integer, json } from 'drizzle-orm/pg-core';

export const categoryEnum = pgEnum('category', [
  'oracle-database',
  'ebs-suite',
  'weblogic',
  'golden-gate',
  'disaster-recovery',
  'rac-clusterware',
  'ebs-isg',
  'soa-suite',
  'fusion-middleware',
  'linux-admin',
  'exadata',
  'essbase',
  'identity-management',
  'golden-gate-problems',
  'ebs-functional',
  'postgresql',
  'oracle-ml',
  'exalogic',
  'postgres-ml',
  'appsdba',
  'performance-dw',
  'netsuite',
  'oracle-clinical',
  'fusion-cloud-erp',
  'oracle-security',
  'ebs-workflow',
  'oracle-retail',
  'oracle-agile',
  'oracle-siebel',
  'pharma-clinical-trials',
  'sap-hana',
  'oracle-google-cloud',
  'fusion-cloud-scm',
  'obiee',
  'oracle-atg',
  'odoo',
  'otm',
  'docker-oracle',
  'mulesoft',
]);

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  excerpt: text('excerpt'),
  content: text('content').notNull(),
  category: categoryEnum('category').notNull(),
  youtubeUrl: varchar('youtube_url', { length: 500 }),
  videoUrl: varchar('video_url', { length: 500 }),
  isPremium: boolean('is_premium').notNull().default(false),
  published: boolean('published').notNull().default(false),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;

export const subscriptions = pgTable('subscriptions', {
  id: serial('id').primaryKey(),
  clerkUserId: varchar('clerk_user_id', { length: 255 }).notNull().unique(),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }).unique(),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }).unique(),
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  status: varchar('status', { length: 50 }).notNull().default('inactive'),
  currentPeriodEnd: timestamp('current_period_end'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Subscription = typeof subscriptions.$inferSelect;

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  clerkUserId: varchar('clerk_user_id', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 255 }),
  lastName: varchar('last_name', { length: 255 }),
  imageUrl: varchar('image_url', { length: 500 }),
  provider: varchar('provider', { length: 50 }).default('email'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;

export const marketingExpenses = pgTable('marketing_expenses', {
  id: serial('id').primaryKey(),
  description: varchar('description', { length: 255 }).notNull(),
  amount: integer('amount').notNull(), // stored in cents
  category: varchar('category', { length: 100 }).notNull().default('other'),
  expenseDate: timestamp('expense_date').notNull(),
  notes: text('notes'),
  createdBy: varchar('created_by', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type MarketingExpense = typeof marketingExpenses.$inferSelect;
export type NewMarketingExpense = typeof marketingExpenses.$inferInsert;

export const emailContacts = pgTable('email_contacts', {
  id: serial('id').primaryKey(),
  firstName: varchar('first_name', { length: 255 }),
  lastName: varchar('last_name', { length: 255 }),
  email: varchar('email', { length: 255 }).notNull().unique(),
  status: varchar('status', { length: 50 }).notNull().default('subscribed'),
  referralCode: varchar('referral_code', { length: 50 }).unique(),
  referredById: integer('referred_by_id'),
  tags: text('tags'),
  notes: text('notes'),
  emailsSent: integer('emails_sent').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type EmailContact = typeof emailContacts.$inferSelect;
export type NewEmailContact = typeof emailContacts.$inferInsert;

export const emailCampaigns = pgTable('email_campaigns', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  subject: varchar('subject', { length: 500 }).notNull(),
  previewText: varchar('preview_text', { length: 500 }),
  bodyHtml: text('body_html').notNull(),
  postId: integer('post_id'),
  category: varchar('category', { length: 100 }),
  status: varchar('status', { length: 50 }).notNull().default('draft'),
  scheduledAt: timestamp('scheduled_at'),
  sentAt: timestamp('sent_at'),
  totalSent: integer('total_sent').notNull().default(0),
  totalOpens: integer('total_opens').notNull().default(0),
  totalClicks: integer('total_clicks').notNull().default(0),
  totalUnsubscribes: integer('total_unsubscribes').notNull().default(0),
  totalBounces: integer('total_bounces').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type EmailCampaign = typeof emailCampaigns.$inferSelect;
export type NewEmailCampaign = typeof emailCampaigns.$inferInsert;

export const emailSends = pgTable('email_sends', {
  id: serial('id').primaryKey(),
  campaignId: integer('campaign_id').notNull(),
  contactId: integer('contact_id').notNull(),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  sentAt: timestamp('sent_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type EmailSend = typeof emailSends.$inferSelect;

export const emailEvents = pgTable('email_events', {
  id: serial('id').primaryKey(),
  sendId: integer('send_id').notNull(),
  campaignId: integer('campaign_id').notNull(),
  contactId: integer('contact_id').notNull(),
  eventType: varchar('event_type', { length: 50 }).notNull(),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  metadata: text('metadata'),
});

export type EmailEvent = typeof emailEvents.$inferSelect;

// ── CRM: Prospect Pipeline ────────────────────────────────────────────────

export const crmProspects = pgTable('crm_prospects', {
  id: serial('id').primaryKey(),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  email: varchar('email', { length: 255 }).notNull().unique(),
  company: varchar('company', { length: 200 }),
  jobTitle: varchar('job_title', { length: 200 }),
  phone: varchar('phone', { length: 50 }),
  // lead | qualified | interested | trial | converted | lost
  source: varchar('source', { length: 50 }).notNull().default('organic'),
  stage: varchar('stage', { length: 50 }).notNull().default('lead'),
  score: integer('score').notNull().default(0),
  notes: text('notes'),
  tags: json('tags').$type<string[]>().default([]),
  nextFollowUpAt: timestamp('next_follow_up_at'),
  lastContactedAt: timestamp('last_contacted_at'),
  convertedAt: timestamp('converted_at'),
  linkedContactId: integer('linked_contact_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type CrmProspect = typeof crmProspects.$inferSelect;
export type NewCrmProspect = typeof crmProspects.$inferInsert;

export const crmActivities = pgTable('crm_activities', {
  id: serial('id').primaryKey(),
  prospectId: integer('prospect_id').notNull(),
  // note | email | call | meeting | demo | follow-up
  type: varchar('type', { length: 50 }).notNull().default('note'),
  subject: varchar('subject', { length: 500 }),
  body: text('body'),
  // positive | neutral | negative | no-response
  outcome: varchar('outcome', { length: 50 }),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type CrmActivity = typeof crmActivities.$inferSelect;
export type NewCrmActivity = typeof crmActivities.$inferInsert;
