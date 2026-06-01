import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { posts } from './schema';
import { like, or } from 'drizzle-orm';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

async function main() {
  console.log('Running paywall migration...');

  // Add is_premium column to posts
  await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE`;
  console.log('Added is_premium column to posts');

  // Create subscriptions table
  await sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      clerk_user_id VARCHAR(255) NOT NULL UNIQUE,
      stripe_customer_id VARCHAR(255) UNIQUE,
      stripe_subscription_id VARCHAR(255) UNIQUE,
      stripe_price_id VARCHAR(255),
      status VARCHAR(50) NOT NULL DEFAULT 'inactive',
      current_period_end TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  console.log('Created subscriptions table');

  // Mark runbooks and deep-dive performance posts as premium
  const result = await db
    .update(posts)
    .set({ isPremium: true })
    .where(
      or(
        like(posts.slug, '%-runbook%'),
        like(posts.slug, '%-performance-tuning%'),
        like(posts.slug, '%linux-kernel-memory%'),
        like(posts.slug, '%exadata-performance%'),
      )
    );

  console.log('Marked runbooks and performance posts as premium');
  console.log('Migration complete.');
}

main().catch(console.error);
