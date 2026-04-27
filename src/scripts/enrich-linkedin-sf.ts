#!/usr/bin/env npx ts-node

/**
 * LinkedIn Open-to-Work Status Enrichment Script - San Francisco Bay Area
 *
 * Scrapes LinkedIn profiles to check "Open to Work" status for users
 * in the San Francisco Bay Area region, ranked by their contribution score.
 *
 * This script:
 * 1. Filters users by San Francisco Bay Area locations (case-insensitive)
 * 2. Ranks filtered users by total_score
 * 3. Skips top 250 ranked profiles
 * 4. From rank 251+, finds users who:
 *    - HAVE LinkedIn URLs
 *    - DON'T already have is_open_to_work set (TRUE or FALSE)
 * 5. Processes the first 2000 matching users
 * 6. Uses Apify API to check Open-to-Work status
 * 7. Updates the leaderboard table with results
 *
 * Location filter includes:
 * San Francisco, SF, San Fran, Bay Area, SF Bay Area, Silicon Valley,
 * Mission Bay, Berkeley, UC Berkeley, Oakland, Stanford, Palo Alto,
 * Mountain View, Cupertino, Menlo Park, San Jose, SJ, Daly City,
 * Sausalito, Alameda, San Bruno, Brisbane, Tiburon, Burlingame
 *
 * Configuration:
 * - APIFY_API_TOKEN: Apify API token
 * - DATABASE_URL: PostgreSQL connection string
 */

import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

// Load environment variables
config({ path: '.env.local' });
config({ path: '.env' });

// San Francisco Bay Area location patterns
const SF_BAY_AREA_LOCATIONS = [
  'san francisco',
  'sf',
  'san fran',
  'bay area',
  'sf bay area',
  'silicon valley',
  'mission bay',
  'berkeley',
  'uc berkeley',
  'oakland',
  'stanford',
  'palo alto',
  'mountain view',
  'cupertino',
  'menlo park',
  'san jose',
  'sj',
  'daly city',
  'sausalito',
  'alameda',
  'san bruno',
  'brisbane',
  'tiburon',
  'burlingame',
  'sunnyvale',
  'santa clara',
  'fremont',
  'redwood city',
  'san mateo',
  'hayward',
  'milpitas',
  'pleasanton',
  'livermore',
  'walnut creek',
  'concord',
  'richmond',
  'emeryville',
  'foster city',
  'south san francisco',
  'ssf',
];

// Configuration
const CONFIG = {
  // Database
  databaseUrl: process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL not set'); })(),

  // Apify API
  apifyApiToken: process.env.APIFY_API_TOKEN ?? '',

  // Scraping settings
  skipCount: 250,          // Skip top N profiles in the SF Bay Area
  fetchCount: 2000,        // Fetch next N profiles with LinkedIn (not yet scraped)
  requestDelayMs: 4000,    // Delay between requests to avoid rate limiting
  maxRetries: 2,           // Number of retries for failed requests
  initialRetryDelayMs: 5000,  // Initial delay before first retry (doubles each retry)
};

// Initialize database connection
const sql = neon(CONFIG.databaseUrl);

// Types
interface LeaderboardUser {
  username: string;
  name: string | null;
  linkedin: string | null;
  location: string | null;
  total_score: number;
  rank: number;
  is_open_to_work: boolean | null;
}

export interface OpenToWorkResult {
  success: boolean;
  openToWork: boolean | null;
  error?: string;
}

// ============================================================================
// Apify API Client
// ============================================================================

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Check if a LinkedIn profile is "Open to Work" using Apify API (single attempt)
 */
async function checkOpenToWorkOnce(
  linkedinUrl: string,
  apiToken: string
): Promise<OpenToWorkResult> {
  const endpoint = `https://api.apify.com/v2/acts/bestscrapers~linkedin-open-to-work-status/run-sync-get-dataset-items?token=${apiToken}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        linkedin_url: linkedinUrl,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        openToWork: null,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();

    // Apify returns an array of results
    if (Array.isArray(data) && data.length > 0) {
      const result = data[0];

      // Check for timeout error in response
      if (result.messages && result.messages.includes('timed out')) {
        return {
          success: false,
          openToWork: null,
          error: 'API timeout',
        };
      }

      // Handle different response formats
      if (result.data && typeof result.data.open_to_work === "boolean") {
        return {
          success: true,
          openToWork: result.data.open_to_work,
        };
      }
      if (typeof result.open_to_work === "boolean") {
        return {
          success: true,
          openToWork: result.open_to_work,
        };
      }
    }

    // Direct object response
    if (data.data && typeof data.data.open_to_work === "boolean") {
      return {
        success: true,
        openToWork: data.data.open_to_work,
      };
    }

    return {
      success: false,
      openToWork: null,
      error: `Unexpected response format: ${JSON.stringify(data)}`,
    };
  } catch (error) {
    return {
      success: false,
      openToWork: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if a LinkedIn profile is "Open to Work" using Apify API
 * With retry logic and exponential backoff
 */
export async function checkOpenToWork(
  linkedinUrl: string,
  apiToken: string
): Promise<OpenToWorkResult> {
  let lastResult: OpenToWorkResult = { success: false, openToWork: null, error: 'Unknown error' };

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = CONFIG.initialRetryDelayMs * Math.pow(2, attempt - 1);
      console.log(`   🔄 Retry ${attempt}/${CONFIG.maxRetries} after ${delayMs / 1000}s delay...`);
      await sleep(delayMs);
    }

    lastResult = await checkOpenToWorkOnce(linkedinUrl, apiToken);

    // If successful, return immediately
    if (lastResult.success) {
      return lastResult;
    }

    // If it's a timeout or transient error, retry
    const isRetryable = lastResult.error?.includes('timeout') ||
                        lastResult.error?.includes('timed out') ||
                        lastResult.error?.includes('ETIMEDOUT') ||
                        lastResult.error?.includes('ECONNRESET');

    if (!isRetryable) {
      // Non-retryable error, return immediately
      return lastResult;
    }

    // Log retry attempt
    if (attempt < CONFIG.maxRetries) {
      console.log(`   ⚠ ${lastResult.error} - will retry...`);
    }
  }

  // All retries exhausted
  return lastResult;
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Build the location filter SQL for SF Bay Area
 */
function buildLocationFilter(): string {
  return SF_BAY_AREA_LOCATIONS
    .map(loc => `LOWER(location) LIKE '%${loc}%'`)
    .join(' OR ');
}

const db = {
  /**
   * Ensure required columns exist in the leaderboard table
   */
  async ensureColumns(): Promise<void> {
    console.log('📋 Ensuring database columns exist...');
    try {
      await sql`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS is_open_to_work BOOLEAN`;
      await sql`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS otw_scraped_at TIMESTAMP`;
      console.log('   ✓ Database columns ready\n');
    } catch (error: any) {
      console.log(`   ⚠ Column note: ${error.message}\n`);
    }
  },

  /**
   * Get total count of SF Bay Area users
   */
  async getTotalSFBayAreaCount(): Promise<number> {
    const result = await sql`
      SELECT COUNT(*) as count
      FROM leaderboard
      WHERE location IS NOT NULL
        AND (
          LOWER(location) LIKE '%san francisco%'
          OR LOWER(location) LIKE '%sf%'
          OR LOWER(location) LIKE '%san fran%'
          OR LOWER(location) LIKE '%bay area%'
          OR LOWER(location) LIKE '%sf bay area%'
          OR LOWER(location) LIKE '%silicon valley%'
          OR LOWER(location) LIKE '%mission bay%'
          OR LOWER(location) LIKE '%berkeley%'
          OR LOWER(location) LIKE '%uc berkeley%'
          OR LOWER(location) LIKE '%oakland%'
          OR LOWER(location) LIKE '%stanford%'
          OR LOWER(location) LIKE '%palo alto%'
          OR LOWER(location) LIKE '%mountain view%'
          OR LOWER(location) LIKE '%cupertino%'
          OR LOWER(location) LIKE '%menlo park%'
          OR LOWER(location) LIKE '%san jose%'
          OR LOWER(location) LIKE '%sj%'
          OR LOWER(location) LIKE '%daly city%'
          OR LOWER(location) LIKE '%sausalito%'
          OR LOWER(location) LIKE '%alameda%'
          OR LOWER(location) LIKE '%san bruno%'
          OR LOWER(location) LIKE '%brisbane%'
          OR LOWER(location) LIKE '%tiburon%'
          OR LOWER(location) LIKE '%burlingame%'
          OR LOWER(location) LIKE '%sunnyvale%'
          OR LOWER(location) LIKE '%santa clara%'
          OR LOWER(location) LIKE '%fremont%'
          OR LOWER(location) LIKE '%redwood city%'
          OR LOWER(location) LIKE '%san mateo%'
          OR LOWER(location) LIKE '%hayward%'
          OR LOWER(location) LIKE '%milpitas%'
          OR LOWER(location) LIKE '%pleasanton%'
          OR LOWER(location) LIKE '%livermore%'
          OR LOWER(location) LIKE '%walnut creek%'
          OR LOWER(location) LIKE '%concord%'
          OR LOWER(location) LIKE '%richmond%'
          OR LOWER(location) LIKE '%emeryville%'
          OR LOWER(location) LIKE '%foster city%'
          OR LOWER(location) LIKE '%south san francisco%'
          OR LOWER(location) LIKE '%ssf%'
        )
    `;
    return Number(result[0]?.count ?? 0);
  },

  /**
   * Fetch SF Bay Area users with LinkedIn URLs who haven't been scraped yet
   *
   * Logic:
   * 1. Filter users by SF Bay Area location (case-insensitive)
   * 2. Rank ALL SF Bay Area users by score
   * 3. Skip top N ranked users
   * 4. From remaining, get users who:
   *    - HAVE LinkedIn URLs
   *    - is_open_to_work IS NULL (not already scraped)
   * 5. Return first M matching users
   */
  async fetchRankedSFUsers(offset: number, limit: number): Promise<LeaderboardUser[]> {
    console.log(`📊 Fetching SF Bay Area users...`);
    console.log(`   - Skip top ${offset} ranked profiles`);
    console.log(`   - Get next ${limit} with LinkedIn + not yet scraped`);
    console.log(`   - Formula: score = stars × (user_prs / total_prs)`);

    const users = await sql`
      WITH sf_bay_area_users AS (
        -- First, filter to only SF Bay Area users
        SELECT
          username,
          name,
          linkedin,
          location,
          total_score,
          is_open_to_work
        FROM leaderboard
        WHERE location IS NOT NULL
          AND (
            LOWER(location) LIKE '%san francisco%'
            OR LOWER(location) LIKE '%sf%'
            OR LOWER(location) LIKE '%san fran%'
            OR LOWER(location) LIKE '%bay area%'
            OR LOWER(location) LIKE '%sf bay area%'
            OR LOWER(location) LIKE '%silicon valley%'
            OR LOWER(location) LIKE '%mission bay%'
            OR LOWER(location) LIKE '%berkeley%'
            OR LOWER(location) LIKE '%uc berkeley%'
            OR LOWER(location) LIKE '%oakland%'
            OR LOWER(location) LIKE '%stanford%'
            OR LOWER(location) LIKE '%palo alto%'
            OR LOWER(location) LIKE '%mountain view%'
            OR LOWER(location) LIKE '%cupertino%'
            OR LOWER(location) LIKE '%menlo park%'
            OR LOWER(location) LIKE '%san jose%'
            OR LOWER(location) LIKE '%sj%'
            OR LOWER(location) LIKE '%daly city%'
            OR LOWER(location) LIKE '%sausalito%'
            OR LOWER(location) LIKE '%alameda%'
            OR LOWER(location) LIKE '%san bruno%'
            OR LOWER(location) LIKE '%brisbane%'
            OR LOWER(location) LIKE '%tiburon%'
            OR LOWER(location) LIKE '%burlingame%'
            OR LOWER(location) LIKE '%sunnyvale%'
            OR LOWER(location) LIKE '%santa clara%'
            OR LOWER(location) LIKE '%fremont%'
            OR LOWER(location) LIKE '%redwood city%'
            OR LOWER(location) LIKE '%san mateo%'
            OR LOWER(location) LIKE '%hayward%'
            OR LOWER(location) LIKE '%milpitas%'
            OR LOWER(location) LIKE '%pleasanton%'
            OR LOWER(location) LIKE '%livermore%'
            OR LOWER(location) LIKE '%walnut creek%'
            OR LOWER(location) LIKE '%concord%'
            OR LOWER(location) LIKE '%richmond%'
            OR LOWER(location) LIKE '%emeryville%'
            OR LOWER(location) LIKE '%foster city%'
            OR LOWER(location) LIKE '%south san francisco%'
            OR LOWER(location) LIKE '%ssf%'
          )
      ),
      ranked_sf_users AS (
        -- Rank SF Bay Area users by total_score
        SELECT
          username,
          name,
          linkedin,
          location,
          total_score,
          is_open_to_work,
          ROW_NUMBER() OVER (ORDER BY total_score DESC) as rank
        FROM sf_bay_area_users
      )
      -- Get users after the skip threshold who have LinkedIn and haven't been scraped
      SELECT username, name, linkedin, location, total_score, rank, is_open_to_work
      FROM ranked_sf_users
      WHERE rank > ${offset}
        AND linkedin IS NOT NULL
        AND linkedin != ''
        AND is_open_to_work IS NULL  -- Only scrape if not already done
      ORDER BY rank ASC
      LIMIT ${limit}
    ` as unknown as LeaderboardUser[];

    return users;
  },

  /**
   * Get count of already scraped users in SF Bay Area (for stats)
   */
  async getAlreadyScrapedCount(): Promise<{ openToWork: number; notOpenToWork: number }> {
    const result = await sql`
      SELECT
        COUNT(*) FILTER (WHERE is_open_to_work = true) as open_to_work,
        COUNT(*) FILTER (WHERE is_open_to_work = false) as not_open_to_work
      FROM leaderboard
      WHERE location IS NOT NULL
        AND (
          LOWER(location) LIKE '%san francisco%'
          OR LOWER(location) LIKE '%sf%'
          OR LOWER(location) LIKE '%san fran%'
          OR LOWER(location) LIKE '%bay area%'
          OR LOWER(location) LIKE '%sf bay area%'
          OR LOWER(location) LIKE '%silicon valley%'
          OR LOWER(location) LIKE '%mission bay%'
          OR LOWER(location) LIKE '%berkeley%'
          OR LOWER(location) LIKE '%uc berkeley%'
          OR LOWER(location) LIKE '%oakland%'
          OR LOWER(location) LIKE '%stanford%'
          OR LOWER(location) LIKE '%palo alto%'
          OR LOWER(location) LIKE '%mountain view%'
          OR LOWER(location) LIKE '%cupertino%'
          OR LOWER(location) LIKE '%menlo park%'
          OR LOWER(location) LIKE '%san jose%'
          OR LOWER(location) LIKE '%sj%'
          OR LOWER(location) LIKE '%daly city%'
          OR LOWER(location) LIKE '%sausalito%'
          OR LOWER(location) LIKE '%alameda%'
          OR LOWER(location) LIKE '%san bruno%'
          OR LOWER(location) LIKE '%brisbane%'
          OR LOWER(location) LIKE '%tiburon%'
          OR LOWER(location) LIKE '%burlingame%'
          OR LOWER(location) LIKE '%sunnyvale%'
          OR LOWER(location) LIKE '%santa clara%'
          OR LOWER(location) LIKE '%fremont%'
          OR LOWER(location) LIKE '%redwood city%'
          OR LOWER(location) LIKE '%san mateo%'
          OR LOWER(location) LIKE '%hayward%'
          OR LOWER(location) LIKE '%milpitas%'
          OR LOWER(location) LIKE '%pleasanton%'
          OR LOWER(location) LIKE '%livermore%'
          OR LOWER(location) LIKE '%walnut creek%'
          OR LOWER(location) LIKE '%concord%'
          OR LOWER(location) LIKE '%richmond%'
          OR LOWER(location) LIKE '%emeryville%'
          OR LOWER(location) LIKE '%foster city%'
          OR LOWER(location) LIKE '%south san francisco%'
          OR LOWER(location) LIKE '%ssf%'
        )
        AND linkedin IS NOT NULL
        AND linkedin != ''
    `;
    return {
      openToWork: Number(result[0]?.open_to_work ?? 0),
      notOpenToWork: Number(result[0]?.not_open_to_work ?? 0),
    };
  },

  /**
   * Update Open-to-Work status for a user
   */
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

// ============================================================================
// Logging Utilities
// ============================================================================

const logger = {
  header(): void {
    console.log('═'.repeat(70));
    console.log('LinkedIn Open-to-Work Enrichment - San Francisco Bay Area');
    console.log('═'.repeat(70));
    console.log(`Region:        San Francisco Bay Area (${SF_BAY_AREA_LOCATIONS.length} location patterns)`);
    console.log(`Skip count:    ${CONFIG.skipCount} (top ranked SF profiles to skip)`);
    console.log(`Fetch count:   ${CONFIG.fetchCount} (profiles with LinkedIn to process)`);
    console.log(`Request delay: ${CONFIG.requestDelayMs}ms`);
    console.log(`Max retries:   ${CONFIG.maxRetries} (with exponential backoff)`);
    console.log('═'.repeat(70) + '\n');
  },

  credentialStatus(): void {
    if (CONFIG.apifyApiToken) {
      console.log('🔑 Apify API Token: ✓ Configured\n');
    } else {
      console.log('🔑 Apify API Token: ✗ Missing');
      console.log('   Set APIFY_API_TOKEN in .env.local\n');
    }
  },

  async regionStats(): Promise<void> {
    const totalCount = await db.getTotalSFBayAreaCount();
    const scrapedStats = await db.getAlreadyScrapedCount();

    console.log('📍 SF Bay Area Statistics:');
    console.log(`   Total users in region:     ${totalCount}`);
    console.log(`   Already scraped (OTW):     ${scrapedStats.openToWork} ✨`);
    console.log(`   Already scraped (Not OTW): ${scrapedStats.notOpenToWork}`);
    console.log(`   Total already scraped:     ${scrapedStats.openToWork + scrapedStats.notOpenToWork}`);
    console.log('');
  },

  userProgress(rank: number, username: string, location: string | null, score: number, total: number, current: number): void {
    console.log(`\n[${current}/${total}] SF Rank #${rank}: ${username}`);
    console.log(`   Location: ${location ?? 'N/A'}`);
    console.log(`   Score: ${score.toFixed(2)}`);
  },

  linkedinUrl(url: string): void {
    console.log(`   LinkedIn: ${url}`);
  },

  result(result: OpenToWorkResult): void {
    if (!result.success) {
      console.log(`   ✗ Error: ${result.error}`);
    } else if (result.openToWork === null) {
      console.log(`   ⚠ Status: Unknown`);
    } else if (result.openToWork) {
      console.log(`   ✓ Status: OPEN TO WORK ✨`);
    } else {
      console.log(`   ✓ Status: Not actively looking`);
    }
  },

  summary(stats: { total: number; success: number; failed: number; openToWork: number; skipped: number; alreadyScraped: number }): void {
    console.log('\n' + '═'.repeat(70));
    console.log('ENRICHMENT SUMMARY - SF Bay Area');
    console.log('═'.repeat(70));
    console.log(`Top profiles skipped:     ${stats.skipped}`);
    console.log(`Already scraped (saved):  ${stats.alreadyScraped} tokens saved! 💰`);
    console.log(`Profiles processed:       ${stats.total}`);
    console.log(`Successful:               ${stats.success}`);
    console.log(`Failed:                   ${stats.failed}`);
    console.log(`Open to Work found:       ${stats.openToWork}`);
    console.log('═'.repeat(70));
  },
};

// ============================================================================
// Main Execution
// ============================================================================

async function main(): Promise<void> {
  logger.header();
  logger.credentialStatus();

  // Validate credentials
  if (!CONFIG.apifyApiToken) {
    console.error('❌ Missing Apify API Token. Please configure:');
    console.error('   APIFY_API_TOKEN - Your Apify API token');
    console.error('\nGet your token from: https://console.apify.com/account/integrations');
    process.exit(1);
  }

  // Ensure database columns exist
  await db.ensureColumns();

  // Show region statistics
  await logger.regionStats();

  // Get already scraped count for stats
  const scrapedBefore = await db.getAlreadyScrapedCount();
  const alreadyScrapedCount = scrapedBefore.openToWork + scrapedBefore.notOpenToWork;

  // Fetch SF Bay Area users
  const users = await db.fetchRankedSFUsers(CONFIG.skipCount, CONFIG.fetchCount);

  if (users.length === 0) {
    console.log('⚠ No users found matching criteria:');
    console.log('  - In SF Bay Area region');
    console.log('  - After rank ' + CONFIG.skipCount);
    console.log('  - With LinkedIn URL');
    console.log('  - Not already scraped (is_open_to_work IS NULL)');
    console.log('\nAll eligible users may have already been processed!');
    return;
  }

  console.log(`\n✓ Found ${users.length} user(s) to process (${alreadyScrapedCount} already scraped, skipped)\n`);

  // Process each user
  const stats = {
    total: 0,
    success: 0,
    failed: 0,
    openToWork: 0,
    skipped: CONFIG.skipCount,
    alreadyScraped: alreadyScrapedCount,
  };

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    stats.total++;

    logger.userProgress(
      user.rank,
      user.username,
      user.location,
      user.total_score,
      users.length,
      i + 1
    );

    if (!user.linkedin) {
      console.log('   ⚠ No LinkedIn URL, skipping...');
      stats.failed++;
      continue;
    }

    logger.linkedinUrl(user.linkedin);

    try {
      const result = await checkOpenToWork(user.linkedin, CONFIG.apifyApiToken);
      logger.result(result);

      await db.updateOpenToWorkStatus(user.username, result.openToWork);

      if (!result.success) {
        stats.failed++;
      } else {
        stats.success++;
        if (result.openToWork === true) {
          stats.openToWork++;
        }
      }
    } catch (error: any) {
      console.log(`   ✗ Unexpected error: ${error.message}`);
      stats.failed++;

      // Still update timestamp to avoid re-processing
      try {
        await db.updateOpenToWorkStatus(user.username, null);
      } catch {
        // Ignore update errors
      }
    }

    // Add delay between requests
    if (i < users.length - 1) {
      console.log(`   ⏳ Waiting ${CONFIG.requestDelayMs}ms before next request...`);
      await sleep(CONFIG.requestDelayMs);
    }
  }

  logger.summary(stats);
}

// Run the script
main().catch((error) => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
