import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { inArray } from 'drizzle-orm';

const slugs = [
  'oracle-19c-ebs-122-oci-provisioning-availability-zones-load-balancing',
  'oracle-19c-ebs-122-oci-provisioning-availability-zones-load-balancing-runbook',
];

async function main() {
  await db.update(posts)
    .set({ category: 'oracle-cloud-infra' })
    .where(inArray(posts.slug, slugs));
  console.log('Category updated to oracle-cloud-infra for:', slugs);
}

main().catch(console.error);
