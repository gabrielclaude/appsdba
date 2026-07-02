import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS marketing_expenses (
      id SERIAL PRIMARY KEY,
      description VARCHAR(255) NOT NULL,
      amount INTEGER NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'other',
      expense_date TIMESTAMP NOT NULL,
      notes TEXT,
      created_by VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  console.log('marketing_expenses table created');
}

main().catch(console.error);
