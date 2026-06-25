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
import { checkOpenToWork, type OpenToWorkResult } from '../lib/linkedinOpenToWork.js';
import { sleep } from '../utils/async.js';

// Load environment variables
config({ path: '.env.local' });
config({ path: '.env' });

// Configuration
const CONFIG = {
  // Database
  databaseUrl:
    process.env.DATABASE_URL ??
    (() => {
      throw new Error('DATABASE_URL not set');
    })(),

  // Apify API
  apifyApiToken: process.env.APIFY_API_TOKEN ?? '',

  // Scraping settings
  skipCount: 264, // Skip top N profiles
  fetchCount: 995, // Fetch next N profiles with LinkedIn
  requestDelayMs: 4000, // Delay between requests to avoid rate limiting
  maxRetries: 2, // Number of retries for failed requests
  initialRetryDelayMs: 5000, // Initial delay before first retry (doubles each retry)
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

    const users = (await sql`
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
    `) as unknown as LeaderboardUser[];

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
    console.log(
      `Target:        First ${CONFIG.fetchCount} users WITH LinkedIn after rank ${CONFIG.skipCount}`
    );
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

  userProgress(
    rank: number,
    username: string,
    score: number,
    total: number,
    current: number
  ): void {
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

  summary(stats: {
    total: number;
    success: number;
    failed: number;
    openToWork: number;
    skipped: number;
  }): void {
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
    if (!user) continue;
    stats.total++;

    logger.userProgress(
      user.rank, // Actual rank from query
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
      const result = await checkOpenToWork(user.linkedin, CONFIG.apifyApiToken, {
        maxRetries: CONFIG.maxRetries,
        initialRetryDelayMs: CONFIG.initialRetryDelayMs,
      });
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
