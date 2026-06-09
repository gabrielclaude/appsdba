import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log('Adding postgresql enum value...');
  await sql`ALTER TYPE category ADD VALUE IF NOT EXISTS 'postgresql'`;
  console.log('Done.');
}

main().catch(console.error);
