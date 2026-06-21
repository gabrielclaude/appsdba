import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log("Adding 'pharma-clinical-trials' to category enum...");
  await sql`ALTER TYPE category ADD VALUE IF NOT EXISTS 'pharma-clinical-trials'`;
  console.log("Done.");
}

main().catch(console.error);
