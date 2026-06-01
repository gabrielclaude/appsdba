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
]);

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  excerpt: text('excerpt'),
  content: text('content').notNull(),
  category: categoryEnum('category').notNull(),
  youtubeUrl: varchar('youtube_url', { length: 500 }),
  published: boolean('published').notNull().default(false),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
