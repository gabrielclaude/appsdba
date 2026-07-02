import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS email_contacts (
      id SERIAL PRIMARY KEY,
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      email VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(50) NOT NULL DEFAULT 'subscribed',
      referral_code VARCHAR(50) UNIQUE,
      referred_by_id INTEGER,
      tags TEXT,
      notes TEXT,
      emails_sent INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  console.log('email_contacts table created');

  await sql`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      preview_text VARCHAR(500),
      body_html TEXT NOT NULL,
      post_id INTEGER,
      category VARCHAR(100),
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      scheduled_at TIMESTAMP,
      sent_at TIMESTAMP,
      total_sent INTEGER NOT NULL DEFAULT 0,
      total_opens INTEGER NOT NULL DEFAULT 0,
      total_clicks INTEGER NOT NULL DEFAULT 0,
      total_unsubscribes INTEGER NOT NULL DEFAULT 0,
      total_bounces INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  console.log('email_campaigns table created');

  await sql`
    CREATE TABLE IF NOT EXISTS email_sends (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL,
      contact_id INTEGER NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      sent_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  console.log('email_sends table created');

  await sql`
    CREATE TABLE IF NOT EXISTS email_events (
      id SERIAL PRIMARY KEY,
      send_id INTEGER NOT NULL,
      campaign_id INTEGER NOT NULL,
      contact_id INTEGER NOT NULL,
      event_type VARCHAR(50) NOT NULL,
      occurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
      metadata TEXT
    )
  `;
  console.log('email_events table created');

  // Indexes
  await sql`CREATE INDEX IF NOT EXISTS email_sends_campaign_id_idx ON email_sends(campaign_id)`;
  await sql`CREATE INDEX IF NOT EXISTS email_sends_contact_id_idx ON email_sends(contact_id)`;
  await sql`CREATE INDEX IF NOT EXISTS email_events_send_id_idx ON email_events(send_id)`;
  await sql`CREATE INDEX IF NOT EXISTS email_events_campaign_id_idx ON email_events(campaign_id)`;
  await sql`CREATE INDEX IF NOT EXISTS email_events_event_type_idx ON email_events(event_type)`;
  console.log('Indexes created');

  console.log('Email marketing migration complete');
}

main().catch(console.error);
