import { pgTable, serial, text, varchar, timestamp, boolean, pgEnum } from 'drizzle-orm/pg-core';

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
