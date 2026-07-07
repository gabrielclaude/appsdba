import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS crm_prospects (
      id               SERIAL PRIMARY KEY,
      first_name       VARCHAR(100),
      last_name        VARCHAR(100),
      email            VARCHAR(255) NOT NULL UNIQUE,
      company          VARCHAR(200),
      job_title        VARCHAR(200),
      phone            VARCHAR(50),
      source           VARCHAR(50)  NOT NULL DEFAULT 'organic',
      stage            VARCHAR(50)  NOT NULL DEFAULT 'lead',
      score            INTEGER      NOT NULL DEFAULT 0,
      notes            TEXT,
      tags             JSONB        DEFAULT '[]',
      next_follow_up_at TIMESTAMP,
      last_contacted_at TIMESTAMP,
      converted_at     TIMESTAMP,
      linked_contact_id INTEGER,
      created_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP    NOT NULL DEFAULT NOW()
    )
  `;
  console.log('crm_prospects: OK');

  await sql`
    CREATE TABLE IF NOT EXISTS crm_activities (
      id           SERIAL PRIMARY KEY,
      prospect_id  INTEGER      NOT NULL REFERENCES crm_prospects(id) ON DELETE CASCADE,
      type         VARCHAR(50)  NOT NULL DEFAULT 'note',
      subject      VARCHAR(500),
      body         TEXT,
      outcome      VARCHAR(50),
      created_by   VARCHAR(255),
      created_at   TIMESTAMP    NOT NULL DEFAULT NOW()
    )
  `;
  console.log('crm_activities: OK');
}

main().catch(console.error);
