#!/usr/bin/env npx ts-node

/**
 * LinkedIn Open-to-Work Status Enrichment Script
 *
 * Scrapes LinkedIn profiles to check "Open to Work" status for users
 * ranked by their contribution score (score = stars × (user_prs / total_prs)).
 *
 * This script:
 * 1. Ranks ALL users by total_score (regardless of LinkedIn)
 * 2. Skips the top 250 ranked profiles
 * 3. From rank 251 onwards, finds users who HAVE LinkedIn URLs
 * 4. Processes the first 5 users with LinkedIn URLs
 * 5. Uses Apify API to check Open-to-Work status
 * 6. Updates the leaderboard table with results
 *
 * Example: If ranks 251-290 have LinkedIn at positions 254, 261, 274, 275, 279, 281, 287
 *          Then only 254, 261, 274, 275, 279 will be scraped (first 5 with LinkedIn)
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

// Configuration
const CONFIG = {
  // Database
  databaseUrl: process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL not set'); })(),

  // Apify API
  apifyApiToken: process.env.APIFY_API_TOKEN ?? '',

  // Scraping settings
  skipCount: 264,        // Skip top N profiles
  fetchCount: 995,       // Fetch next N profiles with LinkedIn
  requestDelayMs: 4000,  // Delay between requests to avoid rate limiting
  maxRetries: 2,         // Number of retries for failed requests
  initialRetryDelayMs: 5000,  // Initial delay before first retry (doubles each retry)
};

// Initialize database connection
const sql = neon(CONFIG.databaseUrl);

// Types
interface LeaderboardUser {
  username: string;
  name: string | null;
  linkedin: string | null;
  total_score: number;
  rank: number;
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
   * Fetch users with LinkedIn URLs, ranked by total_score among ALL users
   *
   * Logic:
   * 1. Rank ALL users by score (not just those with LinkedIn)
   * 2. Skip top N ranked users
   * 3. From remaining, get first M users who HAVE LinkedIn URLs
   *
   * Example: If ranks 251-290 have LinkedIn at 254, 261, 274, 275, 279, 281, 287
   *          This returns users at ranks 254, 261, 274, 275, 279 (first 5 with LinkedIn)
   *
   * Score formula: score = stars × (user_prs / total_prs)
   */
  async fetchRankedUsers(offset: number, limit: number): Promise<LeaderboardUser[]> {
    console.log(`📊 Fetching first ${limit} users with LinkedIn after rank ${offset}...`);
    console.log(`   Formula: score = stars × (user_prs / total_prs)`);

    const users = await sql`
      WITH ranked_users AS (
        SELECT
          username,
          name,
          linkedin,
          total_score,
          ROW_NUMBER() OVER (ORDER BY total_score DESC) as rank
        FROM leaderboard
      )
      SELECT username, name, linkedin, total_score, rank
      FROM ranked_users
      WHERE rank > ${offset}
        AND linkedin IS NOT NULL
        AND linkedin != ''
      ORDER BY rank ASC
      LIMIT ${limit}
    ` as unknown as LeaderboardUser[];

    return users;
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
    console.log('═'.repeat(60));
    console.log('LinkedIn Open-to-Work Status Enrichment (Apify)');
    console.log('═'.repeat(60));
    console.log(`Skip count:    ${CONFIG.skipCount} (top ranked profiles to skip)`);
    console.log(`Fetch count:   ${CONFIG.fetchCount} (profiles with LinkedIn to process)`);
    console.log(`Target:        First ${CONFIG.fetchCount} users WITH LinkedIn after rank ${CONFIG.skipCount}`);
    console.log(`Request delay: ${CONFIG.requestDelayMs}ms`);
    console.log(`Max retries:   ${CONFIG.maxRetries} (with exponential backoff)`);
    console.log('═'.repeat(60) + '\n');
  },

  credentialStatus(): void {
    if (CONFIG.apifyApiToken) {
      console.log('🔑 Apify API Token: ✓ Configured\n');
    } else {
      console.log('🔑 Apify API Token: ✗ Missing');
      console.log('   Set APIFY_API_TOKEN in .env.local\n');
    }
  },

  userProgress(rank: number, username: string, score: number, total: number, current: number): void {
    console.log(`\n[${current}/${total}] Rank #${rank}: ${username}`);
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

  summary(stats: { total: number; success: number; failed: number; openToWork: number; skipped: number }): void {
    console.log('\n' + '═'.repeat(60));
    console.log('ENRICHMENT SUMMARY');
    console.log('═'.repeat(60));
    console.log(`Profiles skipped:   ${stats.skipped}`);
    console.log(`Profiles processed: ${stats.total}`);
    console.log(`Successful:         ${stats.success}`);
    console.log(`Failed:             ${stats.failed}`);
    console.log(`Open to Work:       ${stats.openToWork}`);
    console.log('═'.repeat(60));
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

  // Fetch users ranked 251-255 (skip top 250)
  const users = await db.fetchRankedUsers(CONFIG.skipCount, CONFIG.fetchCount);

  if (users.length === 0) {
    console.log('⚠ No users found with LinkedIn URLs in the specified range.');
    console.log('  Make sure users have linkedin field populated in the leaderboard table.');
    return;
  }

  console.log(`\n✓ Found ${users.length} user(s) to process\n`);

  // Process each user
  const stats = { total: 0, success: 0, failed: 0, openToWork: 0, skipped: CONFIG.skipCount };

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    stats.total++;

    logger.userProgress(
      user.rank,  // Actual rank from query
      user.username,
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
