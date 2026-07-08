import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { emailContacts, crmProspects } from './schema';
import { sql } from 'drizzle-orm';

async function main() {
  const contacts = await db.select().from(emailContacts);
  console.log(`Found ${contacts.length} email contacts`);

  let inserted = 0;
  let skipped = 0;

  for (const c of contacts) {
    const result = await db
      .insert(crmProspects)
      .values({
        firstName:       c.firstName,
        lastName:        c.lastName,
        email:           c.email,
        notes:           c.notes,
        stage:           c.status === 'unsubscribed' ? 'lost' : 'lead',
        source:          'organic',
        score:           0,
        linkedContactId: c.id,
        createdAt:       c.createdAt,
        updatedAt:       c.updatedAt,
      })
      .onConflictDoNothing()
      .returning({ id: crmProspects.id });

    if (result.length > 0) {
      inserted++;
    } else {
      skipped++;
    }
  }

  console.log(`Done — inserted: ${inserted}, skipped (already existed): ${skipped}`);
}

main().catch(console.error);
