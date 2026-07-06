import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  await sql`ALTER TYPE category ADD VALUE IF NOT EXISTS 'docker-oracle'`;
  console.log('Added docker-oracle to category enum');
}

main().catch(console.error);
