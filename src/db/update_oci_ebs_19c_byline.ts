import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { eq, sql } from 'drizzle-orm';

const slug = 'oracle-19c-ebs-122-oci-provisioning-availability-zones-load-balancing';

async function main() {
  await db
    .update(posts)
    .set({
      content: sql`'*By Ravi Sathe*

' || ${posts.content}`,
    })
    .where(eq(posts.slug, slug));
  console.log('Byline added to:', slug);
}

main().catch(console.error);
