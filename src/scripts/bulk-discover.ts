import { db } from '../db/dbClient.js';
import { analyses, leaderboard } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { Octokit } from '@octokit/rest';
import { getBestToken, updateTokenRateLimit, markTokenExhausted } from '../github/tokenPool.js';
import { fetchUserAnalysis } from '../lib/github.js';
import { computeScore } from '../lib/scoring.js';
import { getCachedUser } from '../lib/cache.js';

const CONCURRENCY = 3;
const WAIT_TIME_MS = 60 * 1000; // Reduced to 1 minute for "all tokens exhausted" case
const BATCH_DELAY_MS = 200;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertUserData(scored: any, username: string) {
  const analysisData = {
    id: username.toLowerCase(),
    username: scored.user?.login || username,
    totalScore: scored.totalScore || 0,
    aiScore: scored.aiScore || 0,
    backendScore: scored.backendScore || 0,
    frontendScore: scored.frontendScore || 0,
    devopsScore: scored.devopsScore || 0,
    dataScore: scored.dataScore || 0,
    uniqueSkillsJson: scored.uniqueSkills || [],
    linkedin: scored.user?.linkedin || null,
    topReposJson: scored.topRepositories || [],
    languagesJson: scored.languageBreakdown || {},
    contributionCount: scored.contributionCount || 0,
    cachedAt: new Date(),
  };

  const leaderboardData = {
    username: scored.user?.login || username,
    name: scored.user?.name || username,
    avatarUrl: scored.user?.avatarUrl || `https://github.com/${username}.png`,
    url: scored.user?.url || `https://github.com/${username}`,
    totalScore: scored.totalScore || 0,
    aiScore: scored.aiScore || 0,
    backendScore: scored.backendScore || 0,
    frontendScore: scored.frontendScore || 0,
    devopsScore: scored.devopsScore || 0,
    dataScore: scored.dataScore || 0,
    uniqueSkillsJson: scored.uniqueSkills || [],
    company: scored.user?.company || null,
    blog: scored.user?.websiteUrl || null,
    location: scored.user?.location || null,
    email: scored.user?.email || null,
    bio: scored.user?.bio || null,
    twitterUsername: scored.user?.twitterUsername || null,
    linkedin: scored.user?.linkedin || null,
    hireable: scored.user?.isHireable || false,
    createdAt: new Date(scored.user?.createdAt || Date.now()),
    updatedAt: new Date(),
  };

  await db.insert(analyses).values(analysisData).onConflictDoUpdate({
    target: analyses.id,
    set: analysisData,
  });

  await db.insert(leaderboard).values(leaderboardData).onConflictDoUpdate({
    target: leaderboard.username,
    set: leaderboardData,
  });
}

async function bulkDiscover(location: string, startRangeIndex: number = 0, startPage: number = 1) {
  console.log(`Starting High-Efficiency Pipeline for: ${location}`);

  const ranges = [
    '10..20',
    '21..30',
    '31..40',
    '41..50',
    '51..75',
    '76..100',
    '101..150',
    '151..200',
    '201..300',
    '301..500',
    '501..1000',
    '1001..2000',
    '2001..5000',
    '5001..10000',
    '>10000',
    '0..9',
  ];

  for (let r = startRangeIndex; r < ranges.length; r++) {
    const range = ranges[r];
    console.log(`\nSlicing Range [${r}]: followers:${range}`);

    let page = r === startRangeIndex ? startPage : 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      let tokenInfo;
      try {
        tokenInfo = await getBestToken();
      } catch (e: any) {
        console.log(`🕒 All tokens exhausted. Waiting 1 minute...`);
        await sleep(WAIT_TIME_MS);
        continue;
      }

      try {
        const octokit = new Octokit({ auth: tokenInfo.token });
        const q = `location:"${location}" followers:${range} type:user`;

        console.log(`  Fetching Registry Page ${page} using Token ${tokenInfo.index}...`);
        const { data, headers } = await octokit.search.users({ q, page, per_page: 100 });

        const remaining = parseInt(headers['x-ratelimit-remaining'] || '0', 10);
        const resetTime = parseInt(headers['x-ratelimit-reset'] || '0', 10);
        await updateTokenRateLimit(tokenInfo.index, remaining, resetTime);

        const usernames = data.items.map((u) => u.login);
        if (usernames.length === 0) {
          hasMore = false;
          break;
        }

        console.log(`    Processing ${usernames.length} users in range ${range}`);

        // Freshness Check
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const existingFresh = await db
          .select({ id: analyses.id })
          .from(analyses)
          .where(
            sql`${analyses.id} IN ${usernames.map((u) => u.toLowerCase())} AND ${analyses.cachedAt} > ${oneHourAgo}`
          );

        const freshSet = new Set(existingFresh.map((f) => f.id.toLowerCase()));

        for (let i = 0; i < usernames.length; i += CONCURRENCY) {
          const batch = usernames.slice(i, i + CONCURRENCY);
          const todo = batch.filter((u) => !freshSet.has(u.toLowerCase()));

          if (todo.length === 0) continue;

          let batchSuccess = false;
          while (!batchSuccess) {
            try {
              await Promise.all(
                todo.map(async (username) => {
                  const cached = await getCachedUser(username);
                  const rawData = await fetchUserAnalysis(username);
                  const scored = computeScore(rawData);
                  await insertUserData(scored, username);

                  const label = cached ? '[CACHED]' : '[ADDED]';
                  console.log(
                    `      ${label} ${username} -> Score: ${scored.totalScore.toFixed(1)}`
                  );
                })
              );
              batchSuccess = true;
              await sleep(BATCH_DELAY_MS);
            } catch (batchError: any) {
              if (batchError.message === 'rate-limited-all-tokens' || batchError.status === 403) {
                console.log(`      🕒 Rate limit hit. Rotating token immediately...`);
                // If it was a 403, getBestToken will naturally pick a new one next time
                // if fetchUserAnalysis already marked it as exhausted.
                // We just break the batch retry to pick a new token at the top level.
                break;
              } else {
                console.log(
                  `      ⚠️ Batch error for ${todo.join(',')}: ${batchError.message}. Skipping.`
                );
                batchSuccess = true;
              }
            }
          }
          if (!batchSuccess) {
            // This means we hit a rate limit and need to restart the outer loop to get a new token
            break;
          }
        }

        if (usernames.length < 100) hasMore = false;
        page++;
      } catch (e: any) {
        if (e.status === 403) {
          const retryAfter = parseInt(e.headers?.['retry-after'] || '0', 10);
          const resetTime = parseInt(e.headers?.['x-ratelimit-reset'] || '0', 10);
          console.log(`  🚫 Token ${tokenInfo.index} Rate Limited. Retry-After: ${retryAfter}s`);
          await markTokenExhausted(tokenInfo.index, resetTime);
          // Don't increment page, just retry with a new token
          continue;
        } else {
          console.error(`  Range Error:`, e.message);
          hasMore = false;
        }
      }
    }
  }
  console.log(`\nMission Complete.`);
}

const location = process.argv[2] || 'Sydney';
const startIdx = parseInt(process.argv[3] ?? '0', 10);
const startPage = parseInt(process.argv[4] ?? '1', 10);

bulkDiscover(location, startIdx, startPage).catch(console.error);
