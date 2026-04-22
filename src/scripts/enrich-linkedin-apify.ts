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
 * 4. Uses LinkedIn session cookies to check Open-to-Work status
 * 5. Updates the leaderboard table with results
 *
 * Configuration:
 * - LINKEDIN_LI_AT: LinkedIn session cookie
 * - LINKEDIN_JSESSIONID: LinkedIn CSRF token
 * - DATABASE_URL: PostgreSQL connection string
 */

import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
config({ path: '.env.local' });
config({ path: '.env' });

// Configuration
const CONFIG = {
  // Database
  databaseUrl: process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL not set'); })(),

  // LinkedIn credentials
  linkedinLiAt: process.env.LINKEDIN_LI_AT ?? '',
  linkedinJsessionId: process.env.LINKEDIN_JSESSIONID ?? '',

  // Scraping settings
  skipCount: 250,        // Skip top N profiles
  fetchCount: 5,         // Fetch next N profiles (251-255)
  requestDelayMs: 2000,  // Delay between requests to avoid rate limiting
  requestTimeoutMs: 30000,
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

interface OpenToWorkResult {
  isOpenToWork: boolean | null;
  preferences: Record<string, string>;
  profileName: string | null;
  error?: string;
}

// ============================================================================
// LinkedIn Scraper (based on jamesmurdza/linkedin-opentowork-scraper)
// ============================================================================

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Makes an HTTPS request and returns a promise
 */
function httpsRequest(options: https.RequestOptions, timeout: number = CONFIG.requestTimeoutMs): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, data });
      });
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
    req.end();
  });
}

/**
 * Safely parse JSON without throwing
 */
function safeJsonParse(str: string): { success: boolean; data: any; error: string | null } {
  try {
    return { success: true, data: JSON.parse(str), error: null };
  } catch (e: any) {
    return { success: false, data: null, error: e.message };
  }
}

/**
 * Safely access nested object properties
 */
function safeGet(obj: any, path: string, defaultValue: any = null): any {
  try {
    const keys = path.split('.');
    let result = obj;
    for (const key of keys) {
      if (result === null || result === undefined) return defaultValue;
      result = result[key];
    }
    return result !== undefined && result !== null ? result : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Extract public identifier from LinkedIn URL
 */
function extractPublicIdentifier(input: string): string {
  if (!input || typeof input !== 'string') return '';

  let cleaned = input.trim().replace(/\/+$/, '');

  // Handle full URLs
  const urlMatch = cleaned.match(/linkedin\.com\/in\/([^\/\?#]+)/i);
  if (urlMatch) return urlMatch[1];

  // Return as-is (could be username or URN)
  return cleaned;
}

/**
 * Check if input looks like a profile URN
 */
function isProfileUrn(input: string): boolean {
  return /^ACo[A-Za-z0-9_-]+$/.test(input);
}

/**
 * Fetch profile URN from public identifier
 */
async function fetchProfileUrn(publicIdentifier: string): Promise<string> {
  const apiPath = `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicIdentifier)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-6`;

  const options: https.RequestOptions = {
    hostname: 'www.linkedin.com',
    port: 443,
    path: apiPath,
    method: 'GET',
    headers: {
      'cookie': `li_at=${CONFIG.linkedinLiAt}; JSESSIONID="${CONFIG.linkedinJsessionId}"`,
      'csrf-token': CONFIG.linkedinJsessionId,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  };

  const { statusCode, data } = await httpsRequest(options);

  if (statusCode === 404) throw new Error(`Profile not found: ${publicIdentifier}`);
  if (statusCode === 401 || statusCode === 403) throw new Error('Authentication failed. Check LinkedIn cookies.');
  if (statusCode !== 200) throw new Error(`Failed to fetch profile: HTTP ${statusCode}`);

  const parsed = safeJsonParse(data);
  if (!parsed.success) throw new Error(`Failed to parse response: ${parsed.error}`);

  const elements = safeGet(parsed.data, 'elements', []);
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new Error('Could not find profile in response');
  }

  const entityUrn = safeGet(elements[0], 'entityUrn', '');
  const match = entityUrn.match(/urn:li:fsd_profile:([A-Za-z0-9_-]+)/);
  if (match) return match[1];

  throw new Error('Could not find profile URN in response');
}

/**
 * Fetch Open-to-Work preferences for a profile URN
 */
async function fetchOpenToWorkPreferences(profileUrn: string): Promise<any> {
  const encodedUrn = encodeURIComponent(`urn:li:fsd_profile:${profileUrn}`);
  const apiPath = `/voyager/api/graphql?variables=(profileUrn:${encodedUrn})&queryId=voyagerJobsDashOpenToWorkPreferencesView.6bd7edaa7eeef51da63701e6795d5a51`;

  const options: https.RequestOptions = {
    hostname: 'www.linkedin.com',
    port: 443,
    path: apiPath,
    method: 'GET',
    headers: {
      'cookie': `li_at=${CONFIG.linkedinLiAt}; JSESSIONID="${CONFIG.linkedinJsessionId}"`,
      'csrf-token': CONFIG.linkedinJsessionId,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  };

  const { statusCode, data } = await httpsRequest(options);

  if (statusCode === 401 || statusCode === 403) throw new Error('Authentication failed. Check LinkedIn cookies.');
  if (statusCode !== 200) throw new Error(`HTTP ${statusCode}: Failed to fetch Open To Work preferences`);

  const parsed = safeJsonParse(data);
  if (!parsed.success) throw new Error(`Failed to parse JSON: ${parsed.error}`);

  return parsed.data;
}

/**
 * Extract Open-to-Work data from API response
 */
function extractOpenToWorkData(rawData: any, inputIdentifier: string = ''): OpenToWorkResult {
  if (!rawData) {
    return { isOpenToWork: null, preferences: {}, profileName: null, error: 'No data received' };
  }

  const elements = safeGet(rawData, 'data.jobsDashOpenToWorkPreferencesViewByProfile.elements', []);

  if (!Array.isArray(elements) || elements.length === 0) {
    return { isOpenToWork: false, preferences: {}, profileName: null };
  }

  const element = elements[0] || {};
  const vieweeProfile = safeGet(element, 'vieweeProfile', {});
  const sections = safeGet(element, 'sections', []);

  // Extract preferences
  const preferences: Record<string, string> = {};
  if (Array.isArray(sections)) {
    sections.forEach((section: any) => {
      const name = safeGet(section, 'preferenceName', '');
      const answer = safeGet(section, 'answer', '');
      if (name && answer) preferences[name] = answer;
    });
  }

  // Extract profile data
  const firstName = safeGet(vieweeProfile, 'firstName', '');
  const lastName = safeGet(vieweeProfile, 'lastName', '');
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;

  // Determine Open-to-Work status
  const frameType = safeGet(vieweeProfile, 'profilePicture.frameType', '');
  const preferencesType = safeGet(element, 'preferencesType', '');
  const isOpenToWork = frameType === 'OPEN_TO_WORK' || preferencesType === 'OPEN_TO_WORK';

  return {
    isOpenToWork,
    preferences,
    profileName: fullName,
  };
}

/**
 * Check Open-to-Work status for a LinkedIn profile
 */
async function checkOpenToWork(linkedinUrl: string): Promise<OpenToWorkResult> {
  const publicIdentifier = extractPublicIdentifier(linkedinUrl);

  if (!publicIdentifier) {
    return { isOpenToWork: null, preferences: {}, profileName: null, error: 'Invalid LinkedIn URL' };
  }

  try {
    let profileUrn: string;

    if (isProfileUrn(publicIdentifier)) {
      profileUrn = publicIdentifier;
    } else {
      profileUrn = await fetchProfileUrn(publicIdentifier);
    }

    const rawData = await fetchOpenToWorkPreferences(profileUrn);
    return extractOpenToWorkData(rawData, publicIdentifier);

  } catch (error: any) {
    return {
      isOpenToWork: null,
      preferences: {},
      profileName: null,
      error: error.message,
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
    console.log('LinkedIn Open-to-Work Status Enrichment');
    console.log('═'.repeat(60));
    console.log(`Skip count:    ${CONFIG.skipCount} (top profiles to skip)`);
    console.log(`Fetch count:   ${CONFIG.fetchCount} (profiles to process)`);
    console.log(`Target range:  Rank ${CONFIG.skipCount + 1} to ${CONFIG.skipCount + CONFIG.fetchCount}`);
    console.log(`Request delay: ${CONFIG.requestDelayMs}ms`);
    console.log('═'.repeat(60) + '\n');
  },

  credentialStatus(): void {
    const hasCredentials = CONFIG.linkedinLiAt && CONFIG.linkedinJsessionId;
    if (hasCredentials) {
      console.log('🔑 LinkedIn credentials: ✓ Configured\n');
    } else {
      console.log('🔑 LinkedIn credentials: ✗ Missing');
      console.log('   Set LINKEDIN_LI_AT and LINKEDIN_JSESSIONID in .env.local\n');
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
    if (result.error) {
      console.log(`   ✗ Error: ${result.error}`);
    } else if (result.isOpenToWork === null) {
      console.log(`   ⚠ Status: Unknown`);
    } else if (result.isOpenToWork) {
      console.log(`   ✓ Status: OPEN TO WORK ✨`);
      if (Object.keys(result.preferences).length > 0) {
        console.log(`   Preferences:`);
        for (const [key, value] of Object.entries(result.preferences)) {
          console.log(`     - ${key}: ${value}`);
        }
      }
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
  if (!CONFIG.linkedinLiAt || !CONFIG.linkedinJsessionId) {
    console.error('❌ Missing LinkedIn credentials. Please configure:');
    console.error('   LINKEDIN_LI_AT - Your li_at cookie from LinkedIn');
    console.error('   LINKEDIN_JSESSIONID - Your JSESSIONID cookie from LinkedIn');
    console.error('\nTo get these cookies:');
    console.error('1. Log in to LinkedIn in your browser');
    console.error('2. Open Developer Tools (F12) → Application → Cookies');
    console.error('3. Find www.linkedin.com and copy li_at and JSESSIONID values');
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
      const result = await checkOpenToWork(user.linkedin);
      logger.result(result);

      await db.updateOpenToWorkStatus(user.username, result.isOpenToWork);

      if (result.error) {
        stats.failed++;
      } else {
        stats.success++;
        if (result.isOpenToWork === true) {
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
