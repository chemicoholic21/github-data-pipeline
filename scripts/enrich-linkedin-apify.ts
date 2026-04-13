import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL not set'); })();
const APIFY_TOKEN = process.env.APIFY_TOKEN ?? (() => { throw new Error('APIFY_TOKEN not set'); })();
const sql = neon(DATABASE_URL);

const APIFY_BASE_URL = 'https://api.apify.com/v2/acts/bestscrapers~linkedin-open-to-work-status/run-sync-get-dataset-items';
const MAX_RETRIES = 2;
const DELAY_MS = 1500;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ApifyResult { isOpenToWork: boolean; }
type User = { username: string; linkedin: string; total_score: number };

const apify = {
  async fetch(linkedinUrl: string): Promise<boolean | null> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${APIFY_BASE_URL}?token=${APIFY_TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileUrls: [linkedinUrl] }),
        });
        if (!res.ok) {
          const msg = await res.text();
          if (res.status === 401 || res.status === 403) throw new Error(`Auth failed: ${msg}`);
          if (attempt < MAX_RETRIES) { await sleep(DELAY_MS * (attempt + 1)); continue; }
          throw new Error(`API ${res.status}`);
        }
        const data = (await res.json()) as ApifyResult[];
        return data[0]?.isOpenToWork ?? null;
      } catch (e: any) {
        if (attempt === MAX_RETRIES) throw e;
        await sleep(DELAY_MS * (attempt + 1));
      }
    }
    return null;
  },
};

const db = {
  async ensureColumns() {
    try { await sql`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS is_open_to_work BOOLEAN`; } catch {}
    try { await sql`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS otw_scraped_at TIMESTAMP`; } catch {}
  },
  async fetchTopUsers(limit: number = 5): Promise<User[]> {
    return await sql`
      SELECT username, linkedin, total_score FROM leaderboard
      WHERE linkedin IS NOT NULL
      ORDER BY total_score DESC
      LIMIT ${limit}
    ` as unknown as User[];
  },
  async update(username: string, isOpenToWork: boolean | null) {
    await sql`UPDATE leaderboard SET is_open_to_work = ${isOpenToWork}, otw_scraped_at = NOW() WHERE username = ${username}`;
  },
};

const log = {
  progress: (n: number, total: number, username: string) => console.log(`[${n}/${total}] ${username}`),
  success: (result: boolean | null) => console.log(`  ✓ OpenToWork: ${result}`),
  error: (msg: string) => console.log(`  ✗ ${msg}`),
  summary: (total: number, success: number, failed: number) => console.log(`\n--- Summary ---\nTotal: ${total}\nSuccess: ${success}\nFailed: ${failed}`),
};

async function main() {
  await db.ensureColumns();
  const users = await db.fetchTopUsers(5);
  if (!users.length) { console.log('No users to process'); return; }

  console.log(`Found ${users.length} users to process\n`);

  let processed = 0, success = 0, failed = 0;
  for (const user of users) {
    processed++;
    log.progress(processed, users.length, user.username);
    try {
      const result = await apify.fetch(user.linkedin!);
      await db.update(user.username, result);
      log.success(result);
      success++;
    } catch (e: any) {
      log.error(e.message);
      failed++;
    }
    if (processed < users.length) await sleep(DELAY_MS);
  }
  log.summary(processed, success, failed);
}

main().catch(console.error);