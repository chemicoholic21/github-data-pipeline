/**
 * populate-leaderboard-from-cache.ts
 *
 * This script populates the leaderboard and all intermediate tables from cached
 * API responses in the api_cache table. It does NOT make any GitHub API calls.
 *
 * The script:
 * 1. Reads all cached GraphQL responses from api_cache table
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
 *   --batch-size=<n>        Number of users to process per batch (default: 50)
 *   --skip-scoring          Only populate intermediate tables, skip scoring stages
 *
 * Examples:
 *   npx tsx src/scripts/populate-leaderboard-from-cache.ts
 *   npx tsx src/scripts/populate-leaderboard-from-cache.ts --username=torvalds
 *   npx tsx src/scripts/populate-leaderboard-from-cache.ts --dry-run
 *   npx tsx src/scripts/populate-leaderboard-from-cache.ts --batch-size=100
 */

import { db } from '../db/dbClient.js';
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
import { sql, notInArray } from 'drizzle-orm';

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
// Main processing functions
// ============================================================================

interface ProcessingStats {
  totalCacheEntries: number;
  userProfiles: number;
  userRepos: number;
  repoPRs: number;
  unknownEntries: number;
  usersProcessed: number;
  usersScored: number;
  errors: number;
}

interface ParsedCacheData {
  userProfiles: Map<string, User>;
  userRepos: Map<string, Repository[]>;
  repoPRs: Map<string, PullRequest[]>; // key: "owner/repo"
  repoToUsers: Map<string, Set<string>>; // Maps repo to users who contributed
}

/**
 * Read and parse all entries from api_cache table
 */
async function parseCacheEntries(dryRun: boolean): Promise<ParsedCacheData> {
  console.log('\n[CACHE] Reading api_cache table...');

  const cacheEntries = await db
    .select({
      cacheKey: apiCache.cacheKey,
      response: apiCache.response,
    })
    .from(apiCache);

  console.log(`[CACHE] Found ${cacheEntries.length} cache entries`);

  const data: ParsedCacheData = {
    userProfiles: new Map(),
    userRepos: new Map(),
    repoPRs: new Map(),
    repoToUsers: new Map(),
  };

  const stats = {
    userProfiles: 0,
    userRepos: 0,
    repoPRs: 0,
    unknown: 0,
  };

  for (const entry of cacheEntries) {
    const responseType = detectResponseType(entry.response);

    switch (responseType) {
      case 'user_profile': {
        const user = parseUserProfile(entry.response as CachedUserProfileResponse);
        data.userProfiles.set(user.login.toLowerCase(), user);
        stats.userProfiles++;
        break;
      }

      case 'user_repos': {
        const repos = parseUserRepos(entry.response as CachedUserReposResponse);
        // Try to extract username from the repos (owner of owned repos)
        // or from the cache key pattern
        for (const repo of repos) {
          const repoKey = `${repo.ownerLogin}/${repo.name}`;
          if (!data.userRepos.has(repo.ownerLogin.toLowerCase())) {
            data.userRepos.set(repo.ownerLogin.toLowerCase(), []);
          }
          // Store repos by owner
          const existingRepos = data.userRepos.get(repo.ownerLogin.toLowerCase())!;
          if (!existingRepos.find(r => r.name === repo.name && r.ownerLogin === repo.ownerLogin)) {
            existingRepos.push(repo);
          }
        }
        stats.userRepos++;
        break;
      }

      case 'repo_prs': {
        // For repo PRs, we need to extract owner/repo from the PR data
        const response = entry.response as CachedRepoPRsResponse;
        const nodes = response.repository?.pullRequests?.nodes ?? [];
        if (nodes.length > 0 && nodes[0].url) {
          // Extract owner/repo from PR URL: https://github.com/owner/repo/pull/123
          const urlMatch = nodes[0].url.match(/github\.com\/([^/]+)\/([^/]+)\/pull/);
          if (urlMatch) {
            const [, owner, repo] = urlMatch;
            const repoKey = `${owner}/${repo}`;
            const prs = parseRepoPRs(response, owner, repo);
            data.repoPRs.set(repoKey, prs);

            // Track which users contributed to this repo
            for (const pr of prs) {
              if (!data.repoToUsers.has(repoKey)) {
                data.repoToUsers.set(repoKey, new Set());
              }
              data.repoToUsers.get(repoKey)!.add(pr.authorLogin.toLowerCase());
            }
          }
        }
        stats.repoPRs++;
        break;
      }

      default:
        stats.unknown++;
    }
  }

  console.log(`[CACHE] Parsed cache entries:`);
  console.log(`  - User profiles: ${stats.userProfiles} (${data.userProfiles.size} unique users)`);
  console.log(`  - User repos queries: ${stats.userRepos}`);
  console.log(`  - Repo PRs queries: ${stats.repoPRs} (${data.repoPRs.size} unique repos)`);
  console.log(`  - Unknown/skipped: ${stats.unknown}`);

  return data;
}

/**
 * Populate intermediate tables from parsed cache data
 */
async function populateIntermediateTables(
  data: ParsedCacheData,
  targetUsername: string | null,
  dryRun: boolean
): Promise<string[]> {
  const processedUsers: string[] = [];

  // Determine which users to process
  let usersToProcess: string[];
  if (targetUsername) {
    usersToProcess = [targetUsername.toLowerCase()];
  } else {
    // Get all unique usernames from profiles
    usersToProcess = Array.from(data.userProfiles.keys());
  }

  console.log(`\n[POPULATE] Processing ${usersToProcess.length} users...`);

  for (const username of usersToProcess) {
    try {
      const userProfile = data.userProfiles.get(username);

      if (!userProfile) {
        console.log(`  [${username}] ⚠️ No profile data in cache, skipping`);
        continue;
      }

      if (dryRun) {
        console.log(`  [${username}] Would populate: profile ✓`);

        // Count repos for this user
        const userRepos = data.userRepos.get(username) || [];
        console.log(`  [${username}] Would populate: ${userRepos.length} repos`);

        // Count PRs for this user across all cached repos
        let prCount = 0;
        for (const [repoKey, prs] of data.repoPRs) {
          const userPrs = prs.filter(pr => pr.authorLogin.toLowerCase() === username);
          prCount += userPrs.length;
        }
        console.log(`  [${username}] Would populate: ${prCount} PRs`);

        processedUsers.push(username);
        continue;
      }

      // 1. Upsert user profile
      console.log(`  [${username}] Upserting profile...`);
      await upsertGithubUser(userProfile);

      // 2. Upsert repositories
      const userRepos = data.userRepos.get(username) || [];
      for (const repo of userRepos) {
        await upsertGithubRepo(repo);
      }
      console.log(`  [${username}] Upserted ${userRepos.length} repos`);

      // 3. Insert PRs for this user from all cached repo PRs
      let totalPRs = 0;
      for (const [repoKey, prs] of data.repoPRs) {
        const userPrs = prs.filter(pr => pr.authorLogin.toLowerCase() === username);
        if (userPrs.length > 0) {
          await insertPullRequests(userPrs);
          totalPRs += userPrs.length;
        }
      }
      console.log(`  [${username}] Inserted ${totalPRs} PRs`);

      processedUsers.push(username);
      console.log(`  [${username}] ✅ Intermediate tables populated`);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`  [${username}] ❌ Error: ${errorMsg}`);
    }
  }

  return processedUsers;
}

/**
 * Run scoring pipeline for users (stages 2-4)
 */
async function runScoringPipeline(
  usernames: string[],
  data: ParsedCacheData,
  dryRun: boolean,
  batchSize: number
): Promise<number> {
  console.log(`\n[SCORING] Running pipeline for ${usernames.length} users...`);

  if (dryRun) {
    console.log(`[SCORING] Dry run - would score ${usernames.length} users`);
    return usernames.length;
  }

  let scoredCount = 0;

  // Process in batches
  for (let i = 0; i < usernames.length; i += batchSize) {
    const batch = usernames.slice(i, i + batchSize);
    console.log(`\n[SCORING] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(usernames.length / batchSize)} (${batch.length} users)`);

    for (const username of batch) {
      try {
        // Get linkedin from parsed profile for this user
        const userProfile = data.userProfiles.get(username.toLowerCase());
        const linkedin = userProfile?.linkedin ?? null;

        // Stage 2: Compute repo scores
        await updateUserRepoScores(username);

        // Stage 3: Aggregate scores and sync to leaderboard
        await updateUserScores(username, linkedin);

        // Stage 4: Analyze skills
        await analyzeUserSkills(username);

        scoredCount++;
        console.log(`  [${username}] ✅ Scored and analyzed`);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`  [${username}] ❌ Scoring error: ${errorMsg}`);
      }
    }
  }

  return scoredCount;
}

/**
 * Find users that exist in githubUsers but not in leaderboard
 */
async function findUsersNotInLeaderboard(): Promise<string[]> {
  console.log('\n[CHECK] Finding users missing from leaderboard...');

  const result = await db
    .select({ username: githubUsers.username })
    .from(githubUsers)
    .leftJoin(leaderboard, sql`${githubUsers.username} = ${leaderboard.username}`)
    .where(sql`${leaderboard.username} IS NULL`);

  const usernames = result.map(r => r.username);
  console.log(`[CHECK] Found ${usernames.length} users in githubUsers but not in leaderboard`);

  return usernames;
}

// ============================================================================
// Main entry point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let targetUsername: string | null = null;
  let dryRun = false;
  let batchSize = 50;
  let skipScoring = false;

  for (const arg of args) {
    if (arg.startsWith('--username=')) {
      targetUsername = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--batch-size=')) {
      batchSize = parseInt(arg.split('=')[1], 10) || 50;
    } else if (arg === '--skip-scoring') {
      skipScoring = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: npx tsx src/scripts/populate-leaderboard-from-cache.ts [options]

Options:
  --username=<username>   Process only a specific user
  --dry-run               Preview what would be processed without making changes
  --batch-size=<n>        Number of users to process per batch (default: 50)
  --skip-scoring          Only populate intermediate tables, skip scoring stages
  --help, -h              Show this help message

Examples:
  npx tsx src/scripts/populate-leaderboard-from-cache.ts
  npx tsx src/scripts/populate-leaderboard-from-cache.ts --username=torvalds
  npx tsx src/scripts/populate-leaderboard-from-cache.ts --dry-run
  npx tsx src/scripts/populate-leaderboard-from-cache.ts --batch-size=100
`);
      process.exit(0);
    }
  }

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║        POPULATE LEADERBOARD FROM CACHE                           ║');
  console.log('║        (No GitHub API calls - uses cached data only)             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Configuration:`);
  console.log(`  - Target user: ${targetUsername || 'ALL'}`);
  console.log(`  - Dry run: ${dryRun}`);
  console.log(`  - Batch size: ${batchSize}`);
  console.log(`  - Skip scoring: ${skipScoring}`);

  try {
    // Step 1: Parse cache entries
    const cacheData = await parseCacheEntries(dryRun);

    if (cacheData.userProfiles.size === 0) {
      console.log('\n[ERROR] No user profiles found in api_cache. Nothing to process.');
      process.exit(1);
    }

    // Step 2: Populate intermediate tables
    const processedUsers = await populateIntermediateTables(cacheData, targetUsername, dryRun);

    if (processedUsers.length === 0) {
      console.log('\n[WARN] No users were processed.');
      process.exit(0);
    }

    // Step 3: Run scoring pipeline (unless skipped)
    let scoredCount = 0;
    if (!skipScoring) {
      scoredCount = await runScoringPipeline(processedUsers, cacheData, dryRun, batchSize);
    } else {
      console.log('\n[SCORING] Skipped (--skip-scoring flag)');
    }

    // Final summary
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                        SUMMARY                                   ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');
    console.log(`  Cache entries parsed: ${cacheData.userProfiles.size} user profiles`);
    console.log(`  Users processed: ${processedUsers.length}`);
    console.log(`  Users scored: ${scoredCount}`);
    if (dryRun) {
      console.log('\n  ⚠️  DRY RUN - No changes were made to the database');
    } else {
      console.log('\n  ✅ Database updated successfully');
    }

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
