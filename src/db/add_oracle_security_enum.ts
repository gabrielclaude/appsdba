import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log("Adding 'oracle-security' to category enum...");
  await sql`ALTER TYPE category ADD VALUE IF NOT EXISTS 'oracle-security'`;
  console.log("Done.");
}

main().catch(console.error);
