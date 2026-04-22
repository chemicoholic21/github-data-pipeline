#!/usr/bin/env npx ts-node

/**
 * LinkedIn Open-to-Work Status Enrichment Script
 *
 * Scrapes LinkedIn profiles to check "Open to Work" status for users
 * ranked by their contribution score (score = stars × (user_prs / total_prs)).
 *
 * This script:
 * 1. Fetches users from the leaderboard table ranked by total_score
 * 2. Skips the top 250 profiles
 * 3. Processes profiles ranked 251-255
 * 4. Uses Apify API to check Open-to-Work status
 * 5. Updates the leaderboard table with results
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
  skipCount: 250,        // Skip top N profiles
  fetchCount: 5,         // Fetch next N profiles (251-255)
  requestDelayMs: 2000,  // Delay between requests to avoid rate limiting
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
 * Check if a LinkedIn profile is "Open to Work" using Apify API
 */
export async function checkOpenToWork(
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
   * Fetch users ranked by total_score, with pagination
   *
   * Score formula: score = stars × (user_prs / total_prs)
   * This is pre-computed and stored in total_score column.
   */
  async fetchRankedUsers(offset: number, limit: number): Promise<LeaderboardUser[]> {
    console.log(`📊 Fetching users ranked ${offset + 1} to ${offset + limit}...`);
    console.log(`   Formula: score = stars × (user_prs / total_prs)`);

    const users = await sql`
      SELECT
        username,
        name,
        linkedin,
        total_score,
        ROW_NUMBER() OVER (ORDER BY total_score DESC) as rank
      FROM leaderboard
      WHERE linkedin IS NOT NULL AND linkedin != ''
      ORDER BY total_score DESC
      OFFSET ${offset}
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
    console.log(`Skip count:    ${CONFIG.skipCount} (top profiles to skip)`);
    console.log(`Fetch count:   ${CONFIG.fetchCount} (profiles to process)`);
    console.log(`Target range:  Rank ${CONFIG.skipCount + 1} to ${CONFIG.skipCount + CONFIG.fetchCount}`);
    console.log(`Request delay: ${CONFIG.requestDelayMs}ms`);
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
      CONFIG.skipCount + i + 1,  // Actual rank
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
