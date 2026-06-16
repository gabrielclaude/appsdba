import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log("Adding 'oracle-clinical' to category enum...");
  await sql`ALTER TYPE category ADD VALUE IF NOT EXISTS 'oracle-clinical'`;
  console.log("Done.");
}

main().catch(console.error);
