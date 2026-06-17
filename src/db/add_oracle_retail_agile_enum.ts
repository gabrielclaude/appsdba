import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  await sql`ALTER TYPE category ADD VALUE IF NOT EXISTS 'oracle-retail'`;
  console.log("Added 'oracle-retail' to category enum");
  await sql`ALTER TYPE category ADD VALUE IF NOT EXISTS 'oracle-agile'`;
  console.log("Added 'oracle-agile' to category enum");
}

main().catch(console.error);
