<<<<<<< HEAD
import 'dotenv/config';
=======
import { config } from 'dotenv';
>>>>>>> 8d03a364e5123475caf32d399a6498f77acd4189
import { neon } from '@neondatabase/serverless';

// Load environment variables from .env.local
config({ path: '.env.local' });

const DATABASE_URL = process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL not set. Please configure .env.local'); })();
const APIFY_TOKEN = process.env.APIFY_TOKEN ?? (() => { throw new Error('APIFY_TOKEN not set. Please configure .env.local'); })();
const sql = neon(DATABASE_URL);

// Apify Actor Configuration
// Using freshdata actor which is more commonly documented
const APIFY_ACTOR_ID = 'freshdata~linkedin-open-to-work-status';
const APIFY_BASE_URL = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items`;

// Retry and Rate Limiting Configuration
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1500;
const REQUEST_DELAY_MS = 2000; // Delay between requests to avoid rate limiting

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Types
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

// LinkedIn URL normalization utilities
const linkedinUtils = {
  /**
   * Normalize LinkedIn URL to a standard format
   * Handles various input formats:
   * - https://linkedin.com/in/username
   * - https://www.linkedin.com/in/username
   * - linkedin.com/in/username
   * - /in/username
   * - username (assumes it's a LinkedIn username)
   */
  normalizeUrl(url: string): string {
    if (!url) return '';

    let normalized = url.trim();

    // Remove trailing slashes
    normalized = normalized.replace(/\/+$/, '');

    // If it's just a username (no slashes or dots), construct the full URL
    if (!normalized.includes('/') && !normalized.includes('.')) {
      return `https://www.linkedin.com/in/${normalized}`;
    }

    // If it starts with /in/, add the domain
    if (normalized.startsWith('/in/')) {
      return `https://www.linkedin.com${normalized}`;
    }

    // If it starts with in/, add the domain
    if (normalized.startsWith('in/')) {
      return `https://www.linkedin.com/${normalized}`;
    }

    // If it doesn't have a protocol, add https://
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = `https://${normalized}`;
    }

    // Ensure www subdomain for consistency
    normalized = normalized.replace('://linkedin.com', '://www.linkedin.com');

    return normalized;
  },

  /**
   * Validate if the URL is a proper LinkedIn profile URL
   */
  isValidProfileUrl(url: string): boolean {
    try {
      const normalized = this.normalizeUrl(url);
      const urlObj = new URL(normalized);
      return (
        urlObj.hostname.includes('linkedin.com') &&
        urlObj.pathname.startsWith('/in/')
      );
    } catch {
      return false;
    }
  },

  /**
   * Extract username from LinkedIn URL
   */
  extractUsername(url: string): string | null {
    const match = url.match(/\/in\/([^/?#]+)/);
    return match ? match[1] : null;
  },
};

// Apify API client with retry logic and exponential backoff
const apifyClient = {
  async checkOpenToWork(linkedinUrl: string): Promise<boolean | null> {
    const normalizedUrl = linkedinUtils.normalizeUrl(linkedinUrl);

    if (!linkedinUtils.isValidProfileUrl(normalizedUrl)) {
      console.log(`    ⚠ Invalid LinkedIn URL format: ${linkedinUrl}`);
      return null;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt); // Exponential backoff

      try {
        console.log(`    → Checking: ${normalizedUrl}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

        const requestBody = {
          urls: [normalizedUrl], // Try 'urls' field
        };

        const res = await fetch(`${APIFY_BASE_URL}?token=${APIFY_TOKEN}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        // Handle authentication errors - don't retry
        if (res.status === 401 || res.status === 403) {
          const errorText = await res.text();
          throw new Error(`Authentication failed (${res.status}): ${errorText}. Check your APIFY_TOKEN.`);
        }

        // Handle rate limiting
        if (res.status === 429) {
          console.log(`    ⚠ Rate limited, waiting ${delay * 2}ms before retry...`);
          await sleep(delay * 2);
          continue;
        }

        // Handle bad request - might be input format issue
        if (res.status === 400) {
          const errorText = await res.text();
          console.log(`    ⚠ Bad request (400): ${errorText}`);

          // Try alternative input format (profileUrls instead of urls)
          if (attempt === 0) {
            console.log(`    → Trying alternative input format...`);
            const altRequestBody = {
              profileUrls: [normalizedUrl],
            };

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

        // Handle other non-OK responses
        if (!res.ok) {
          const errorText = await res.text();
          if (attempt < MAX_RETRIES) {
            console.log(`    ⚠ API error ${res.status}, retrying in ${delay}ms...`);
            await sleep(delay);
            continue;
          }
          throw new Error(`API error ${res.status}: ${errorText}`);
        }

        // Parse successful response
        const data = (await res.json()) as ApifyResult[];
        return this.parseResult(data);

      } catch (error: any) {
        // Don't retry auth errors
        if (error.message.includes('Authentication failed')) {
          throw error;
        }

        // Retry on network errors
        if (attempt < MAX_RETRIES) {
          console.log(`    ⚠ Error: ${error.message}, retrying in ${delay}ms...`);
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
      console.log(`    ⚠ Empty response from API`);
      return null;
    }

    const result = data[0];

    // Handle error responses
    if (result.error) {
      console.log(`    ⚠ API returned error: ${result.error}`);
      return null;
    }

    // Check various possible field names for the result
    const isOpenToWork = result.isOpenToWork ?? result.openToWorkStatus ?? null;

    return isOpenToWork;
  },
};

// Database operations
const db = {
  async ensureColumns(): Promise<void> {
    console.log('Ensuring database columns exist...');
    try {
      await sql`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS is_open_to_work BOOLEAN`;
      await sql`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS otw_scraped_at TIMESTAMP`;
      console.log('✓ Database columns ready\n');
    } catch (error: any) {
      // Columns might already exist or table structure varies
      console.log(`⚠ Column creation note: ${error.message}\n`);
    }
  },

  async fetchTopUsers(limit: number = 5): Promise<User[]> {
    console.log(`Fetching top ${limit} users with LinkedIn URLs...`);
    const users = await sql`
      SELECT username, linkedin, total_score
      FROM leaderboard
      WHERE linkedin IS NOT NULL AND linkedin != ''
      ORDER BY total_score DESC
      LIMIT ${limit}
    ` as unknown as User[];

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

// Logging utilities
const logger = {
  progress(current: number, total: number, username: string, score: number): void {
    console.log(`\n[${current}/${total}] Processing: ${username} (score: ${score.toFixed(2)})`);
  },

  success(isOpenToWork: boolean | null): void {
    if (isOpenToWork === null) {
      console.log(`    ✓ Status: Unknown (could not determine)`);
    } else if (isOpenToWork) {
      console.log(`    ✓ Status: OPEN TO WORK ✨`);
    } else {
      console.log(`    ✓ Status: Not actively looking`);
    }
  },

  error(message: string): void {
    console.log(`    ✗ Error: ${message}`);
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

// Main execution
async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('LinkedIn Open-to-Work Status Enrichment');
  console.log('='.repeat(50));
  console.log(`Actor: ${APIFY_ACTOR_ID}`);
  console.log(`Max retries: ${MAX_RETRIES}`);
  console.log(`Request delay: ${REQUEST_DELAY_MS}ms\n`);

  // Ensure database columns exist
  await db.ensureColumns();

  // Fetch top users
  const users = await db.fetchTopUsers(5);

  if (users.length === 0) {
    console.log('No users found with LinkedIn URLs. Nothing to process.');
    return;
  }

  console.log(`Found ${users.length} user(s) to process\n`);

  // Process each user
  const stats = { total: 0, success: 0, failed: 0, openToWork: 0 };

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
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
    } catch (error: any) {
      logger.error(error.message);
      stats.failed++;

      // Still update the timestamp even on failure to avoid re-processing
      try {
        await db.updateOpenToWorkStatus(user.username, null);
      } catch {
        // Ignore update errors
      }
    }

    // Add delay between requests to avoid rate limiting
    if (i < users.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  logger.summary(stats);
}

// Run the script
main().catch((error) => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
