/**
 * populate-leaderboard-from-cache.ts
 *
 * This script populates the leaderboard and all intermediate tables from cached
 * API responses in the api_cache table. It does NOT make any GitHub API calls.
 *
 * MEMORY EFFICIENT: Processes cache entries in batches using database cursors
 * to avoid loading all 400k+ entries into memory at once.
 *
 * The script:
 * 1. Reads cached GraphQL responses from api_cache table IN BATCHES
 * 2. Parses and identifies response types (user profile, user repos, repo PRs)
 * 3. Populates intermediate tables: githubUsers, githubRepos, githubPullRequests
 * 4. Runs scoring pipeline stages 2-4 (compute, aggregate, analyze)
 * 5. Updates leaderboard table with scored profiles
 *
 * Usage:
 *   npx tsx src/scripts/populate-leaderboard-from-cache.ts [options]
 *
 * Options:
 *   --username=<username>   Process only a specific user
 *   --dry-run               Preview what would be processed without making changes
 *   --batch-size=<n>        Number of cache entries to process per batch (default: 1000)
 *   --skip-scoring          Only populate intermediate tables, skip scoring stages
 *   --offset=<n>            Start processing from this offset (for resuming)
 *   --limit=<n>             Process only this many users (for testing)
 *
 * Examples:
 *   npx tsx src/scripts/populate-leaderboard-from-cache.ts
 *   npx tsx src/scripts/populate-leaderboard-from-cache.ts --username=torvalds
 *   npx tsx src/scripts/populate-leaderboard-from-cache.ts --dry-run
 *   npx tsx src/scripts/populate-leaderboard-from-cache.ts --batch-size=500 --limit=100
 */

import { db, pool } from '../db/dbClient.js';
import { apiCache, githubUsers, leaderboard } from '../db/schema.js';
import {
  upsertGithubUser,
  upsertGithubRepo,
  insertPullRequests
} from '../db/upserts.js';
import {
  updateUserRepoScores,
  updateUserScores,
  analyzeUserSkills
} from '../lib/pipeline.js';
import type { User, Repository, PullRequest } from '../types/github.js';
import { sql, eq, and, isNull } from 'drizzle-orm';

// ============================================================================
// Types for cached API responses
// ============================================================================

interface CachedUserProfileResponse {
  user: {
    login: string;
    name: string | null;
    avatarUrl: string;
    url: string;
    bio: string | null;
    followers: { totalCount: number };
    following: { totalCount: number };
    createdAt: string;
    updatedAt: string;
    isHireable: boolean;
    company: string | null;
    websiteUrl: string | null;
    location: string | null;
    email: string;
    twitterUsername: string | null;
    socialAccounts: {
      nodes: Array<{
        provider: string;
        url: string;
      }>;
    };
  };
}

interface CachedUserReposResponse {
  user: {
    login?: string;
    repositories: {
      nodes: Array<{
        name: string;
        owner: { login: string };
        stargazerCount: number;
        primaryLanguage: { name: string } | null;
        pushedAt: string | null;
        isFork: boolean;
        pullRequests: { totalCount: number };
        repositoryTopics: {
          nodes: Array<{ topic: { name: string } }>;
        };
        languages: {
          nodes: Array<{ name: string }>;
        };
      }>;
    };
    repositoriesContributedTo: {
      nodes: Array<{
        name: string;
        owner: { login: string };
        stargazerCount: number;
        primaryLanguage: { name: string } | null;
        pushedAt: string | null;
        isFork: boolean;
        pullRequests: { totalCount: number };
        repositoryTopics: {
          nodes: Array<{ topic: { name: string } }>;
        };
        languages: {
          nodes: Array<{ name: string }>;
        };
      }>;
    };
  };
}

interface CachedRepoPRsResponse {
  repository: {
    pullRequests: {
      nodes: Array<{
        id: string;
        url: string;
        author: { login: string } | null;
        state: string;
        mergedAt: string | null;
        createdAt: string;
      }>;
    };
  };
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Extract LinkedIn URL from social accounts, bio, or website URL
 */
function extractLinkedIn(
  socialAccounts: Array<{ provider: string; url: string }> | undefined,
  bio: string | null,
  websiteUrl: string | null
): string | null {
  const linkedInAccount = socialAccounts?.find((account) => account.provider === 'LINKEDIN');
  if (linkedInAccount) {
    return linkedInAccount.url;
  }

  const linkedinRegex = /(?:linkedin\.com\/in\/|lnkd\.in\/)([a-zA-Z0-9_-]+)/i;
  if (bio) {
    const match = bio.match(linkedinRegex);
    if (match) return `https://linkedin.com/in/${match[1]}`;
  }
  if (websiteUrl) {
    const match = websiteUrl.match(linkedinRegex);
    if (match) return `https://linkedin.com/in/${match[1]}`;
  }
  return null;
}

/**
 * Detect the type of cached response based on its structure
 */
function detectResponseType(response: unknown): 'user_profile' | 'user_repos' | 'repo_prs' | 'unknown' {
  if (!response || typeof response !== 'object') return 'unknown';

  const res = response as Record<string, unknown>;

  // Check for user profile response (has user object with login, followers, etc. but NOT repositories)
  if (res.user && typeof res.user === 'object') {
    const user = res.user as Record<string, unknown>;

    // User repos response has both repositories and repositoriesContributedTo
    if (user.repositories && user.repositoriesContributedTo) {
      return 'user_repos';
    }

    // User profile response has login, followers, following but no repositories
    if (user.login && user.followers && user.following && !user.repositories) {
      return 'user_profile';
    }
  }

  // Check for repo PRs response
  if (res.repository && typeof res.repository === 'object') {
    const repo = res.repository as Record<string, unknown>;
    if (repo.pullRequests) {
      return 'repo_prs';
    }
  }

  return 'unknown';
}

/**
 * Parse a cached user profile response into a User object
 */
function parseUserProfile(response: CachedUserProfileResponse): User {
  const { user } = response;
  return {
    login: user.login,
    name: user.name ?? undefined,
    avatarUrl: user.avatarUrl,
    url: user.url,
    company: user.company ?? undefined,
    blog: user.websiteUrl ?? undefined,
    location: user.location ?? undefined,
    email: user.email,
    bio: user.bio ?? undefined,
    twitterUsername: user.twitterUsername ?? undefined,
    linkedin: extractLinkedIn(user.socialAccounts?.nodes, user.bio, user.websiteUrl) ?? undefined,
    isHireable: user.isHireable,
    websiteUrl: user.websiteUrl ?? undefined,
    followers: user.followers.totalCount,
    following: user.following.totalCount,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Parse a cached user repos response into Repository objects
 */
function parseUserRepos(response: CachedUserReposResponse): Repository[] {
  const allNodes = [
    ...(response.user?.repositories?.nodes ?? []),
    ...(response.user?.repositoriesContributedTo?.nodes ?? []),
  ];

  const uniqueReposMap = new Map<string, Repository>();
  for (const node of allNodes) {
    if (!node?.owner?.login || !node?.name) continue;
    const fullName = `${node.owner.login}/${node.name}`;
    if (!uniqueReposMap.has(fullName)) {
      uniqueReposMap.set(fullName, {
        name: node.name,
        ownerLogin: node.owner.login,
        stargazerCount: node.stargazerCount ?? 0,
        primaryLanguage: node.primaryLanguage?.name ?? null,
        pushedAt: node.pushedAt ?? null,
        isFork: node.isFork ?? false,
        mergedPrCount: node.pullRequests?.totalCount ?? 0,
        mergedPrsByUserCount: 0,
        topics: node.repositoryTopics?.nodes?.map((n) => n.topic.name) ?? [],
        languages: node.languages?.nodes?.map((n) => n.name) ?? [],
      });
    }
  }

  return Array.from(uniqueReposMap.values());
}

/**
 * Parse a cached repo PRs response into PullRequest objects
 */
function parseRepoPRs(response: CachedRepoPRsResponse, owner: string, repo: string): PullRequest[] {
  const nodes = response.repository?.pullRequests?.nodes ?? [];
  return nodes.map((node) => ({
    id: node.id,
    url: node.url,
    repoId: `${owner}/${repo}`,
    authorLogin: node.author?.login || 'ghost',
    mergedAt: node.mergedAt || '',
    createdAt: node.createdAt,
  }));
}

// ============================================================================
// Streaming/Batched processing functions
// ============================================================================

interface ProcessingStats {
  totalCacheEntries: number;
  userProfilesFound: number;
  userReposFound: number;
  repoPRsFound: number;
  unknownEntries: number;
  usersPopulated: number;
  usersScored: number;
  errors: number;
}

/**
 * Process a single user: populate their data from cache and optionally score them
 */
async function processUserFromCache(
  username: string,
  dryRun: boolean,
  skipScoring: boolean,
  stats: ProcessingStats
): Promise<boolean> {
  try {
    // Step 1: Find user profile in cache by scanning for their profile response
    // We need to search cache entries that contain this user's profile
    const profileEntries = await db
      .select({ response: apiCache.response })
      .from(apiCache)
      .where(sql`${apiCache.response}::jsonb -> 'user' ->> 'login' ILIKE ${username}`)
      .limit(1);

    if (profileEntries.length === 0) {
      console.log(`  [${username}] ⚠️ No profile found in cache`);
      return false;
    }

    const profileResponse = profileEntries[0].response as CachedUserProfileResponse;
    const responseType = detectResponseType(profileResponse);

    if (responseType !== 'user_profile') {
      console.log(`  [${username}] ⚠️ Found entry is not a user profile (type: ${responseType})`);
      return false;
    }

    const user = parseUserProfile(profileResponse);

    if (dryRun) {
      console.log(`  [${username}] Would populate profile ✓`);
      stats.usersPopulated++;
      return true;
    }

    // Step 2: Upsert user profile
    await upsertGithubUser(user);
    console.log(`  [${username}] ✅ Profile upserted`);

    // Step 3: Find and process user's repos from cache
    const reposEntries = await db
      .select({ response: apiCache.response })
      .from(apiCache)
      .where(sql`
        ${apiCache.response}::jsonb -> 'user' -> 'repositories' IS NOT NULL
        AND ${apiCache.response}::jsonb -> 'user' -> 'repositoriesContributedTo' IS NOT NULL
      `)
      .limit(5000); // Process repos in chunks

    let reposUpserted = 0;
    const userReposSet = new Set<string>(); // Track repos associated with this user

    for (const entry of reposEntries) {
      const reposResponse = entry.response as CachedUserReposResponse;
      const repos = parseUserRepos(reposResponse);

      for (const repo of repos) {
        // Check if this repo is owned by or contributed to by this user
        const repoKey = `${repo.ownerLogin}/${repo.name}`;

        // We'll upsert all repos we find - they may be relevant for PR matching later
        await upsertGithubRepo(repo);
        reposUpserted++;

        if (repo.ownerLogin.toLowerCase() === username.toLowerCase()) {
          userReposSet.add(repoKey);
        }
      }
    }
    console.log(`  [${username}] ✅ ${reposUpserted} repos upserted`);

    // Step 4: Find and process PRs for this user from cache
    const prEntries = await db
      .select({ response: apiCache.response })
      .from(apiCache)
      .where(sql`${apiCache.response}::jsonb -> 'repository' -> 'pullRequests' IS NOT NULL`)
      .limit(10000);

    let prsInserted = 0;
    for (const entry of prEntries) {
      const prResponse = entry.response as CachedRepoPRsResponse;
      const nodes = prResponse.repository?.pullRequests?.nodes ?? [];

      if (nodes.length > 0 && nodes[0]?.url) {
        const urlMatch = nodes[0].url.match(/github\.com\/([^/]+)\/([^/]+)\/pull/);
        if (urlMatch) {
          const [, owner, repo] = urlMatch;
          const prs = parseRepoPRs(prResponse, owner, repo);

          // Filter PRs by this user
          const userPrs = prs.filter(pr => pr.authorLogin.toLowerCase() === username.toLowerCase());
          if (userPrs.length > 0) {
            await insertPullRequests(userPrs);
            prsInserted += userPrs.length;
          }
        }
      }
    }
    console.log(`  [${username}] ✅ ${prsInserted} PRs inserted`);

    stats.usersPopulated++;

    // Step 5: Run scoring pipeline if not skipped
    if (!skipScoring) {
      try {
        await updateUserRepoScores(username);
        await updateUserScores(username, user.linkedin ?? null);
        await analyzeUserSkills(username);
        stats.usersScored++;
        console.log(`  [${username}] ✅ Scored and analyzed`);
      } catch (scoreError: unknown) {
        const errorMsg = scoreError instanceof Error ? scoreError.message : String(scoreError);
        console.error(`  [${username}] ⚠️ Scoring error: ${errorMsg}`);
      }
    }

    return true;
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`  [${username}] ❌ Error: ${errorMsg}`);
    stats.errors++;
    return false;
  }
}

/**
 * Get all unique usernames from cached user profiles (memory efficient)
 */
async function getAllCachedUsernames(batchSize: number, offset: number, limit: number | null): Promise<string[]> {
  console.log('\n[CACHE] Scanning for unique usernames in api_cache...');

  const usernames: string[] = [];
  let currentOffset = 0;
  let totalScanned = 0;

  while (true) {
    // Query batch of cache entries that look like user profiles
    const batch = await db
      .select({ response: apiCache.response })
      .from(apiCache)
      .where(sql`
        ${apiCache.response}::jsonb -> 'user' ->> 'login' IS NOT NULL
        AND ${apiCache.response}::jsonb -> 'user' -> 'followers' IS NOT NULL
        AND ${apiCache.response}::jsonb -> 'user' -> 'repositories' IS NULL
      `)
      .limit(batchSize)
      .offset(currentOffset);

    if (batch.length === 0) break;

    for (const entry of batch) {
      const response = entry.response as CachedUserProfileResponse;
      if (response.user?.login) {
        const username = response.user.login.toLowerCase();
        if (!usernames.includes(username)) {
          usernames.push(username);
        }
      }
    }

    totalScanned += batch.length;
    currentOffset += batchSize;

    // Progress update every 10k entries
    if (totalScanned % 10000 === 0) {
      console.log(`  [SCAN] Scanned ${totalScanned} entries, found ${usernames.length} unique users...`);
    }

    // Check if we've reached the limit
    if (limit && usernames.length >= limit + offset) {
      break;
    }
  }

  console.log(`[CACHE] Found ${usernames.length} unique user profiles in cache`);

  // Apply offset and limit
  let result = usernames;
  if (offset > 0) {
    result = result.slice(offset);
    console.log(`[CACHE] After offset ${offset}: ${result.length} users remaining`);
  }
  if (limit) {
    result = result.slice(0, limit);
    console.log(`[CACHE] After limit ${limit}: ${result.length} users to process`);
  }

  return result;
}

/**
 * Get usernames that exist in cache but not in leaderboard
 */
async function getUsernamesMissingFromLeaderboard(batchSize: number, limit: number | null): Promise<string[]> {
  console.log('\n[CACHE] Finding users in cache but missing from leaderboard...');

  // First get all usernames from leaderboard (this should be manageable)
  const leaderboardUsers = await db
    .select({ username: leaderboard.username })
    .from(leaderboard);

  const leaderboardSet = new Set(leaderboardUsers.map(u => u.username.toLowerCase()));
  console.log(`[CACHE] Found ${leaderboardSet.size} users already in leaderboard`);

  // Now scan cache for users NOT in leaderboard
  const missingUsernames: string[] = [];
  let currentOffset = 0;
  let totalScanned = 0;

  while (true) {
    const batch = await db
      .select({ response: apiCache.response })
      .from(apiCache)
      .where(sql`
        ${apiCache.response}::jsonb -> 'user' ->> 'login' IS NOT NULL
        AND ${apiCache.response}::jsonb -> 'user' -> 'followers' IS NOT NULL
        AND ${apiCache.response}::jsonb -> 'user' -> 'repositories' IS NULL
      `)
      .limit(batchSize)
      .offset(currentOffset);

    if (batch.length === 0) break;

    for (const entry of batch) {
      const response = entry.response as CachedUserProfileResponse;
      if (response.user?.login) {
        const username = response.user.login.toLowerCase();
        if (!leaderboardSet.has(username) && !missingUsernames.includes(username)) {
          missingUsernames.push(username);
        }
      }
    }

    totalScanned += batch.length;
    currentOffset += batchSize;

    if (totalScanned % 10000 === 0) {
      console.log(`  [SCAN] Scanned ${totalScanned} entries, found ${missingUsernames.length} missing users...`);
    }

    if (limit && missingUsernames.length >= limit) {
      break;
    }
  }

  console.log(`[CACHE] Found ${missingUsernames.length} users missing from leaderboard`);

  if (limit) {
    return missingUsernames.slice(0, limit);
  }

  return missingUsernames;
}

// ============================================================================
// Main entry point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let targetUsername: string | null = null;
  let dryRun = false;
  let batchSize = 1000;
  let skipScoring = false;
  let offset = 0;
  let limit: number | null = null;
  let onlyMissing = false;

  for (const arg of args) {
    if (arg.startsWith('--username=')) {
      targetUsername = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--batch-size=')) {
      batchSize = parseInt(arg.split('=')[1], 10) || 1000;
    } else if (arg === '--skip-scoring') {
      skipScoring = true;
    } else if (arg.startsWith('--offset=')) {
      offset = parseInt(arg.split('=')[1], 10) || 0;
    } else if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.split('=')[1], 10) || null;
    } else if (arg === '--only-missing') {
      onlyMissing = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: npx tsx src/scripts/populate-leaderboard-from-cache.ts [options]

Options:
  --username=<username>   Process only a specific user
  --dry-run               Preview what would be processed without making changes
  --batch-size=<n>        Number of cache entries to scan per batch (default: 1000)
  --skip-scoring          Only populate intermediate tables, skip scoring stages
  --offset=<n>            Start processing from this user index (for resuming)
  --limit=<n>             Process only this many users (for testing)
  --only-missing          Only process users not already in leaderboard
  --help, -h              Show this help message

Examples:
  npx tsx src/scripts/populate-leaderboard-from-cache.ts
  npx tsx src/scripts/populate-leaderboard-from-cache.ts --username=torvalds
  npx tsx src/scripts/populate-leaderboard-from-cache.ts --dry-run --limit=10
  npx tsx src/scripts/populate-leaderboard-from-cache.ts --only-missing --limit=100
  npx tsx src/scripts/populate-leaderboard-from-cache.ts --offset=1000 --limit=500
`);
      process.exit(0);
    }
  }

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║        POPULATE LEADERBOARD FROM CACHE                           ║');
  console.log('║        (No GitHub API calls - uses cached data only)             ║');
  console.log('║        Memory efficient: processes in batches                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Configuration:`);
  console.log(`  - Target user: ${targetUsername || 'ALL'}`);
  console.log(`  - Dry run: ${dryRun}`);
  console.log(`  - Batch size: ${batchSize}`);
  console.log(`  - Skip scoring: ${skipScoring}`);
  console.log(`  - Offset: ${offset}`);
  console.log(`  - Limit: ${limit || 'none'}`);
  console.log(`  - Only missing: ${onlyMissing}`);

  const stats: ProcessingStats = {
    totalCacheEntries: 0,
    userProfilesFound: 0,
    userReposFound: 0,
    repoPRsFound: 0,
    unknownEntries: 0,
    usersPopulated: 0,
    usersScored: 0,
    errors: 0,
  };

  try {
    // Get count of cache entries for reference
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(apiCache);
    stats.totalCacheEntries = Number(countResult[0]?.count || 0);
    console.log(`\n[CACHE] Total entries in api_cache: ${stats.totalCacheEntries.toLocaleString()}`);

    // Determine which users to process
    let usersToProcess: string[];

    if (targetUsername) {
      usersToProcess = [targetUsername];
      console.log(`\n[PROCESS] Processing single user: ${targetUsername}`);
    } else if (onlyMissing) {
      usersToProcess = await getUsernamesMissingFromLeaderboard(batchSize, limit);
    } else {
      usersToProcess = await getAllCachedUsernames(batchSize, offset, limit);
    }

    if (usersToProcess.length === 0) {
      console.log('\n[WARN] No users to process.');
      process.exit(0);
    }

    console.log(`\n[PROCESS] Processing ${usersToProcess.length} users...`);
    console.log('─'.repeat(70));

    // Process each user
    for (let i = 0; i < usersToProcess.length; i++) {
      const username = usersToProcess[i];
      console.log(`\n[${i + 1}/${usersToProcess.length}] Processing: ${username}`);

      await processUserFromCache(username, dryRun, skipScoring, stats);

      // Progress update every 50 users
      if ((i + 1) % 50 === 0) {
        console.log(`\n[PROGRESS] ${i + 1}/${usersToProcess.length} users processed (${stats.usersPopulated} populated, ${stats.usersScored} scored, ${stats.errors} errors)`);
      }
    }

    // Final summary
    console.log('\n' + '═'.repeat(70));
    console.log('                           SUMMARY');
    console.log('═'.repeat(70));
    console.log(`  Total cache entries: ${stats.totalCacheEntries.toLocaleString()}`);
    console.log(`  Users processed: ${usersToProcess.length}`);
    console.log(`  Users populated: ${stats.usersPopulated}`);
    console.log(`  Users scored: ${stats.usersScored}`);
    console.log(`  Errors: ${stats.errors}`);
    if (dryRun) {
      console.log('\n  ⚠️  DRY RUN - No changes were made to the database');
    } else {
      console.log('\n  ✅ Database updated successfully');
    }
    console.log('═'.repeat(70));

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`\n[FATAL] ${errorMsg}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch(console.error);
