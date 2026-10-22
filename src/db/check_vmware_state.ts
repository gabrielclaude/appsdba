import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT id, slug, is_premium FROM posts WHERE slug LIKE '%vmware%' OR category = 'vmware' ORDER BY id DESC` as any[];
  console.log(`vmware posts in DB: ${rows.length}`);
  rows.forEach((r: any) => console.log(` ${r.id}: ${r.slug} premium=${r.is_premium}`));
  const enums = await sql`SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE pg_type.typname = 'category' AND enumlabel = 'vmware'` as any[];
  console.log(`vmware in category enum: ${enums.length > 0}`);
}
main().catch(console.error);
