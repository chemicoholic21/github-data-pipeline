import { db } from '../db/dbClient.js';
import { analyses, leaderboard, githubUsers } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { Octokit } from '@octokit/rest';
import { getBestToken, updateTokenRateLimit, markTokenExhausted } from '../github/tokenPool.js';
import { runPipeline } from '../lib/pipeline.js';
import { getCachedUser } from '../lib/cache.js';

const CONCURRENCY = 3;
const WAIT_TIME_MS = 60 * 1000; // Reduced to 1 minute for "all tokens exhausted" case
const BATCH_DELAY_MS = 200;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(`🕒 All tokens exhausted. Waiting 1 minute... Error: ${errorMsg}`);
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

        // Freshness Check using new schema
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const existingFresh = await db
          .select({ username: githubUsers.username })
          .from(githubUsers)
          .where(
            sql`${githubUsers.username} IN ${usernames} AND ${githubUsers.scrapedAt} > ${oneHourAgo}`
          );

        const freshSet = new Set(existingFresh.map((f) => f.username.toLowerCase()));

        for (let i = 0; i < usernames.length; i += CONCURRENCY) {
          const batch = usernames.slice(i, i + CONCURRENCY);
          const todo = batch.filter((u) => !freshSet.has(u.toLowerCase()));

          if (todo.length === 0) continue;

          let batchSuccess = false;
          while (!batchSuccess) {
            try {
              await Promise.all(
                todo.map(async (username) => {
                  try {
                    const cached = await getCachedUser(username);
                    await runPipeline(username);
                    const label = cached ? '[CACHED]' : '[ADDED]';
                    console.log(`      ${label} ${username} -> Refactored Pipeline Run Complete`);
                  } catch (userError: unknown) {
                    const errorMsg = userError instanceof Error ? userError.message : String(userError);
                    console.error(`      ❌ Error processing ${username}: ${errorMsg}`);
                    throw userError;
                  }
                })
              );
              batchSuccess = true;
              await sleep(BATCH_DELAY_MS);
            } catch (batchError: unknown) {
              const batchErrorObj = batchError instanceof Error ? batchError : new Error(String(batchError));
              if ((batchErrorObj as any).message === 'rate-limited-all-tokens' || (batchErrorObj as any).status === 403) {
                console.log(`      🕒 Rate limit hit. Rotating token immediately...`);
                // If it was a 403, getBestToken will naturally pick a new one next time
                // if fetchUserAnalysis already marked it as exhausted.
                // We just break the batch retry to pick a new token at the top level.
                break;
              } else {
                console.error(
                  `      ⚠️ Batch error for ${todo.join(',')}: ${batchErrorObj.message}`
                );
                if ((batchErrorObj as any).stack) {
                  console.error((batchErrorObj as any).stack);
                }
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
      } catch (e: unknown) {
        const errorObj = e instanceof Error ? e : new Error(String(e));
        if ((errorObj as any).status === 403) {
          const retryAfter = parseInt((errorObj as any).headers?.['retry-after'] || '0', 10);
          const resetTime = parseInt((errorObj as any).headers?.['x-ratelimit-reset'] || '0', 10);
          console.log(`  🚫 Token ${(tokenInfo as any)?.index} Rate Limited. Retry-After: ${retryAfter}s`);
          await markTokenExhausted((tokenInfo as any)?.index || 0, resetTime);
          // Don't increment page, just retry with a new token
          continue;
        } else {
          console.error(`  Range Error:`, errorObj.message);
          if ((errorObj as any).stack) {
            console.error((errorObj as any).stack);
          }
          hasMore = false;
        }
      }
    }
  }
  console.log(`\nMission Complete.`);
}

const locationArg = process.argv[2] || 'Sydney';
const startIdx = parseInt(process.argv[3] ?? '0', 10);
const startPage = parseInt(process.argv[4] ?? '1', 10);

// Split locations by comma and trim whitespace
const locations = locationArg.split(',').map(loc => loc.trim()).filter(loc => loc.length > 0);

console.log(`\n🌍 Processing ${locations.length} location(s): ${locations.join(', ')}\n`);

// Process each location sequentially
(async () => {
  for (let i = 0; i < locations.length; i++) {
    const location = locations[i];
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📍 Location ${i + 1}/${locations.length}: ${location}`);
    console.log(`${'='.repeat(60)}\n`);
    
    await bulkDiscover(location, startIdx, startPage);
  }
  console.log(`\n✅ All ${locations.length} location(s) processed!`);
})().catch(console.error);
