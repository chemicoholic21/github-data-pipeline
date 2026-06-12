/**
 * compute-repo-health.ts
 *
 * Computes the CONTRIBUTION-FRIENDLINESS score for repositories — "is this a
 * good place to send a PR?" (reviewed + merged quickly, alive, newcomer-
 * friendly). This is the v2 of the recommended fix: it scrapes the missing
 * signals (reviews, closed/open PRs, issues, CONTRIBUTING/CoC, releases,
 * real isArchived) PER REPO — removing the maintainer-self-merge sample bias
 * that affects the user-scoped github_pull_requests table.
 *
 * Flow:
 *   - Pick top github_repos by stars that lack a fresh repo_health row.
 *   - fetchRepoHealth(owner, name)  -> RepoHealthMetrics  (one GraphQL call)
 *   - computeContributionScore(m)   -> ContributionScore  (pure, 0..100)
 *   - upsertRepoHealth(m, s)        -> repo_health table
 *   - Reuses the shared token pool + rate-limit backoff from refresh-worker.
 *
 * Run:
 *   npm run compute-repo-health           # daemon over all eligible repos
 *   ONESHOT=1 LIMIT=20 npm run compute-repo-health   # single batch, then exit
 *
 * Tunables (env, all optional):
 *   REPO_HEALTH_MIN_STARS    default 100   (only score repos worth contributing to)
 *   REPO_HEALTH_AFTER_DAYS   default 7     (re-score cadence; matches cache TTL)
 *   REPO_HEALTH_BATCH_SIZE   default 100
 *   PER_REPO_DELAY_MS        default 1500  (secondary-rate-limit pacing)
 *   IDLE_SLEEP_MS            default 300000
 *   ONESHOT                  default 0     (1 = process one batch and exit)
 *   LIMIT                    overrides batch size for a one-shot run
 */

import { sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { getBestToken } from '../github/tokenPool.js';
import { fetchRepoHealth } from '../lib/githubScraper.js';
import { computeContributionScore } from '../lib/scoring.js';
import { upsertRepoHealth } from '../db/upserts.js';

const MIN_STARS = Number(process.env.REPO_HEALTH_MIN_STARS ?? 100);
const AFTER_DAYS = Number(process.env.REPO_HEALTH_AFTER_DAYS ?? 7);
const BATCH_SIZE = Number(process.env.LIMIT ?? process.env.REPO_HEALTH_BATCH_SIZE ?? 100);
const PER_REPO_DELAY_MS = Number(process.env.PER_REPO_DELAY_MS ?? 1500);
const IDLE_SLEEP_MS = Number(process.env.IDLE_SLEEP_MS ?? 5 * 60_000);
const ONESHOT = process.env.ONESHOT === '1';
const MIN_SLEEP_MS = 60_000;
const MAX_SLEEP_MS = 60 * 60_000;
const RETRY_MAX_ATTEMPTS = Number(process.env.RETRY_MAX_ATTEMPTS ?? 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS ?? 10_000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let stopping = false;
function installShutdown() {
  const handler = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[repo-health] received ${sig}, finishing current step and exiting…`);
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

type RepoRow = { owner_login: string; repo_name: string; full_name: string };

/**
 * Eligible = stars >= MIN_STARS, not a fork, and either never scored or scored
 * longer ago than AFTER_DAYS. Highest-star repos first (most valuable to rank).
 */
async function getBatch(limit: number): Promise<RepoRow[]> {
  const { rows } = await db.execute<RepoRow>(sql`
    SELECT gr.owner_login, gr.repo_name, gr.full_name
    FROM github_repos gr
    LEFT JOIN repo_health rh ON rh.full_name = gr.full_name
    WHERE gr.stars >= ${MIN_STARS}
      AND gr.is_fork = false
      AND gr.full_name IS NOT NULL
      AND (
        rh.full_name IS NULL
        OR rh.scored_at < NOW() - (${AFTER_DAYS}::int * INTERVAL '1 day')
      )
    ORDER BY (rh.full_name IS NULL) DESC, gr.stars DESC
    LIMIT ${limit}
  `);
  return rows;
}

async function sleepUntilNextReset(): Promise<void> {
  const { rows } = await db.execute<{ reset_time: number | null }>(sql`
    SELECT MIN(reset_time) AS reset_time FROM token_rate_limit WHERE remaining <= 0
  `);
  const resetUnix = rows[0]?.reset_time ?? 0;
  const targetMs = resetUnix > 0 ? resetUnix * 1000 - Date.now() + 5_000 : MIN_SLEEP_MS;
  const waitMs = Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, targetMs));
  console.log(`[repo-health] all tokens exhausted — sleeping ${Math.round(waitMs / 1000)}s`);
  await sleep(waitMs);
}

async function processRepo(owner: string, name: string): Promise<boolean> {
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const metrics = await fetchRepoHealth(owner, name, false);
      if (!metrics) {
        console.log(`[repo-health] ${owner}/${name} not found — skipping`);
        return false;
      }
      const score = computeContributionScore(metrics);
      await upsertRepoHealth(metrics, score);
      console.log(
        `[repo-health] ${metrics.fullName} score=${score.score} ` +
          `(resp=${fmt(score.responsiveness)} thr=${fmt(score.throughput)} ` +
          `acc=${fmt(score.acceptance)} new=${fmt(score.newcomer)} live=${fmt(score.liveness)} ` +
          `conf=${score.confidence}${score.gatedReason ? ` GATED:${score.gatedReason}` : ''})`
      );
      return true;
    } catch (e) {
      console.error(
        `[repo-health] ${owner}/${name} threw (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}):`,
        (e as Error).message
      );
      if (attempt < RETRY_MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      }
    }
  }
  return false;
}

const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(2));

async function main() {
  installShutdown();
  console.log(
    `[repo-health] starting (min_stars=${MIN_STARS}, after=${AFTER_DAYS}d, ` +
      `batch=${BATCH_SIZE}, delay=${PER_REPO_DELAY_MS}ms, oneshot=${ONESHOT})`
  );

  let processed = 0;

  while (!stopping) {
    const batch = await getBatch(BATCH_SIZE);
    if (batch.length === 0) {
      console.log(`[repo-health] no eligible repos. processed=${processed}`);
      if (ONESHOT) break;
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    console.log(`[repo-health] batch of ${batch.length} repos (highest stars first)`);

    for (const repo of batch) {
      if (stopping) break;

      try {
        await getBestToken(); // pre-flight: bail to sleep if pool is dry
      } catch (e) {
        if (e instanceof Error && e.message === 'rate-limited-all-tokens') {
          await sleepUntilNextReset();
          continue;
        }
        throw e;
      }

      const ok = await processRepo(repo.owner_login, repo.repo_name);
      if (ok) processed++;
      await sleep(PER_REPO_DELAY_MS);
    }

    if (ONESHOT) break;
  }

  console.log(`[repo-health] done. processed=${processed}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[repo-health] fatal error:', err);
  process.exit(1);
});
