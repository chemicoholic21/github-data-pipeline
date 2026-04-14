import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config({ path: '.env.local' });

const DATABASE_URL =
  process.env.DATABASE_URL ??
  (() => {
    throw new Error('DATABASE_URL not set. Please configure .env.local');
  })();
const APIFY_TOKEN =
  process.env.APIFY_TOKEN ??
  (() => {
    throw new Error('APIFY_TOKEN not set. Please configure .env.local');
  })();
const sql = neon(DATABASE_URL);

const APIFY_ACTOR_ID = 'bestscrapers~linkedin-open-to-work-status';
const APIFY_BASE_URL = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items`;

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1500;
const REQUEST_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ApifyResult {
  profileUrl?: string;
  isOpenToWork?: boolean;
  openToWorkStatus?: boolean;
  error?: string;
}

interface User {
  username: string;
  linkedin: string;
  total_score: number;
}

const linkedinUtils = {
  normalizeUrl(url: string): string {
    if (!url) return '';

    let normalized = url.trim();
    normalized = normalized.replace(/\/+$/, '');

    if (!normalized.includes('/') && !normalized.includes('.')) {
      return `https://www.linkedin.com/in/${normalized}`;
    }

    if (normalized.startsWith('/in/')) {
      return `https://www.linkedin.com${normalized}`;
    }

    if (normalized.startsWith('in/')) {
      return `https://www.linkedin.com/${normalized}`;
    }

    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = `https://${normalized}`;
    }

    normalized = normalized.replace('://linkedin.com', '://www.linkedin.com');
    return normalized;
  },

  isValidProfileUrl(url: string): boolean {
    try {
      const normalized = this.normalizeUrl(url);
      const urlObj = new URL(normalized);
      return urlObj.hostname.includes('linkedin.com') && urlObj.pathname.startsWith('/in/');
    } catch {
      return false;
    }
  },

  extractUsername(url: string): string | null {
    const match = url.match(/\/in\/([^/?#]+)/);
    return match ? (match[1] ?? null) : null;
  },
};

const apifyClient = {
  async checkOpenToWork(linkedinUrl: string): Promise<boolean | null> {
    const normalizedUrl = linkedinUtils.normalizeUrl(linkedinUrl);

    if (!linkedinUtils.isValidProfileUrl(normalizedUrl)) {
      console.log(`    Invalid LinkedIn URL format: ${linkedinUrl}`);
      return null;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);

      try {
        console.log(`    Checking: ${normalizedUrl}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

        const requestBody = { urls: [normalizedUrl] };

        const res = await fetch(`${APIFY_BASE_URL}?token=${APIFY_TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (res.status === 401 || res.status === 403) {
          const errorText = await res.text();
          throw new Error(
            `Authentication failed (${res.status}): ${errorText}. Check your APIFY_TOKEN.`
          );
        }

        if (res.status === 429) {
          console.log(`    Rate limited, waiting ${delay * 2}ms before retry...`);
          await sleep(delay * 2);
          continue;
        }

        if (res.status === 400) {
          const errorText = await res.text();
          console.log(`    Bad request (400): ${errorText}`);

          if (attempt === 0) {
            console.log(`    Trying alternative input format...`);
            const altRequestBody = { profileUrls: [normalizedUrl] };

            const altRes = await fetch(`${APIFY_BASE_URL}?token=${APIFY_TOKEN}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(altRequestBody),
            });

            if (altRes.ok) {
              const data = (await altRes.json()) as ApifyResult[];
              return this.parseResult(data);
            }
          }

          if (attempt < MAX_RETRIES) {
            await sleep(delay);
            continue;
          }
          throw new Error(`API returned 400: ${errorText}`);
        }

        if (!res.ok) {
          const errorText = await res.text();
          if (attempt < MAX_RETRIES) {
            console.log(`    API error ${res.status}, retrying in ${delay}ms...`);
            await sleep(delay);
            continue;
          }
          throw new Error(`API error ${res.status}: ${errorText}`);
        }

        const data = (await res.json()) as ApifyResult[];
        return this.parseResult(data);
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('Authentication failed')) {
          throw error;
        }

        if (attempt < MAX_RETRIES) {
          const msg = error instanceof Error ? error.message : String(error);
          console.log(`    Error: ${msg}, retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        throw error;
      }
    }

    return null;
  },

  parseResult(data: ApifyResult[]): boolean | null {
    if (!Array.isArray(data) || data.length === 0) {
      console.log(`    Empty response from API`);
      return null;
    }

    const result = data[0];
    if (!result) {
      console.log(`    Empty response from API`);
      return null;
    }

    if (result.error) {
      console.log(`    API returned error: ${result.error}`);
      return null;
    }

    const isOpenToWork = result.isOpenToWork ?? result.openToWorkStatus ?? null;
    return isOpenToWork;
  },
};

const db = {
  async ensureColumns(): Promise<void> {
    console.log('Ensuring database columns exist...');
    try {
      await sql`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS is_open_to_work BOOLEAN`;
      await sql`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS otw_scraped_at TIMESTAMP`;
      console.log('Database columns ready\n');
    } catch (error: unknown) {
      console.log(
        `Column creation note: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  },

  async fetchTopUsers(limit: number = 5): Promise<User[]> {
    console.log(`Fetching top ${limit} users with LinkedIn URLs...`);
    const users = (await sql`
      SELECT username, linkedin, total_score
      FROM leaderboard
      WHERE linkedin IS NOT NULL AND linkedin != ''
      ORDER BY total_score DESC
      LIMIT ${limit}
    `) as unknown as User[];

    return users;
  },

  async updateOpenToWorkStatus(username: string, isOpenToWork: boolean | null): Promise<void> {
    await sql`
      UPDATE leaderboard
      SET
        is_open_to_work = ${isOpenToWork},
        otw_scraped_at = NOW()
      WHERE username = ${username}
    `;
  },
};

const logger = {
  progress(current: number, total: number, username: string, score: number): void {
    console.log(`\n[${current}/${total}] Processing: ${username} (score: ${score.toFixed(2)})`);
  },

  success(isOpenToWork: boolean | null): void {
    if (isOpenToWork === null) {
      console.log(`    Status: Unknown (could not determine)`);
    } else if (isOpenToWork) {
      console.log(`    Status: OPEN TO WORK`);
    } else {
      console.log(`    Status: Not actively looking`);
    }
  },

  error(message: string): void {
    console.log(`    Error: ${message}`);
  },

  summary(stats: { total: number; success: number; failed: number; openToWork: number }): void {
    console.log(`\n${'='.repeat(50)}`);
    console.log('ENRICHMENT SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total processed:    ${stats.total}`);
    console.log(`Successful:         ${stats.success}`);
    console.log(`Failed:             ${stats.failed}`);
    console.log(`Open to work:       ${stats.openToWork}`);
    console.log('='.repeat(50));
  },
};

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('LinkedIn Open-to-Work Status Enrichment');
  console.log('='.repeat(50));
  console.log(`Actor: ${APIFY_ACTOR_ID}`);
  console.log(`Max retries: ${MAX_RETRIES}`);
  console.log(`Request delay: ${REQUEST_DELAY_MS}ms\n`);

  await db.ensureColumns();

  const users = await db.fetchTopUsers(5);

  if (users.length === 0) {
    console.log('No users found with LinkedIn URLs. Nothing to process.');
    return;
  }

  console.log(`Found ${users.length} user(s) to process\n`);

  const stats = { total: 0, success: 0, failed: 0, openToWork: 0 };

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    if (!user) continue;

    stats.total++;

    logger.progress(i + 1, users.length, user.username, user.total_score);

    try {
      const isOpenToWork = await apifyClient.checkOpenToWork(user.linkedin);
      await db.updateOpenToWorkStatus(user.username, isOpenToWork);

      logger.success(isOpenToWork);
      stats.success++;

      if (isOpenToWork === true) {
        stats.openToWork++;
      }
    } catch (error: unknown) {
      logger.error(error instanceof Error ? error.message : String(error));
      stats.failed++;

      try {
        await db.updateOpenToWorkStatus(user.username, null);
      } catch {
        // Ignore update errors
      }
    }

    if (i < users.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  logger.summary(stats);
}

main().catch((error) => {
  console.error('\nFatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
