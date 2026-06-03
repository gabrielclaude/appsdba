import 'dotenv/config';
import { db } from './index';
import { sql } from 'drizzle-orm';

async function migrate() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      clerk_user_id VARCHAR(255) NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL,
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      image_url VARCHAR(500),
      provider VARCHAR(50) DEFAULT 'email',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  console.log('users table created');
}

migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
