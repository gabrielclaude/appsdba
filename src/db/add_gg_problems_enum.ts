import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  await sql`ALTER TYPE category ADD VALUE IF NOT EXISTS 'golden-gate-problems'`;
  console.log('Enum value golden-gate-problems added');
}

main().catch(console.error);
