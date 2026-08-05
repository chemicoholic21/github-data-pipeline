import { db } from '../db/dbClient.js';
import { sql } from 'drizzle-orm';

async function migrate() {
  console.log('[migrate] adding category column to repo_issues...');

  await db.execute(sql`
    ALTER TABLE repo_issues ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'good_first_issue'
  `);

  console.log('[migrate] dropping old primary key...');
  await db.execute(sql`ALTER TABLE repo_issues DROP CONSTRAINT IF EXISTS repo_issues_pkey`);

  console.log('[migrate] adding new composite primary key...');
  await db.execute(sql`
    ALTER TABLE repo_issues ADD PRIMARY KEY (full_name, github_issue_id, category)
  `);

  console.log('[migrate] done');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('[migrate] fatal error:', e);
  process.exit(1);
});
