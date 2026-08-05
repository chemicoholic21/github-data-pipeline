/**
 * refresh-top-repos.ts
 *
 * Refreshes the top-scoring repositories in repo_health by category/pillar,
 * skipping repos that were scored recently (no re-scraping of fresh data).
 *
 * Categories (pillars):
 *   contribution      combined 0..100 score
 *   responsiveness    time-to-first-review (0..1)
 *   throughput        merge speed + velocity × backlog (0..1)
 *   acceptance        merge rate × external-contributor ratio (0..1)
 *   newcomer          good-first-issues + CONTRIBUTING/CoC (0..1)
 *   liveness          recency of pushes + releases (0..1)
 *
 * Run:
 *   npm run refresh-top-repos                # refresh top 50 across all categories
 *   CATEGORY=throughput LIMIT=20 npm run refresh-top-repos   # single category
 *   AFTER_DAYS=3 npm run refresh-top-repos    # re-score anything older than 3 days
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/dbClient.js';
import { getBestToken } from '../github/tokenPool.js';
import { fetchRepoHealth, fetchGoodFirstIssues } from '../lib/githubScraper.js';
import { computeContributionScore } from '../lib/scoring.js';
import { upsertRepoHealth, upsertRepoIssues } from '../db/upserts.js';
import { sleep, backoffDelay } from '../utils/async.js';

const CATEGORIES = {
  contribution: 'contribution_score',
  responsiveness: 'responsiveness_score',
  throughput: 'throughput_score',
  acceptance: 'acceptance_score',
  newcomer: 'newcomer_score',
  liveness: 'liveness_score',
} as const;

type CategoryKey = keyof typeof CATEGORIES;
type CategoryColumn = (typeof CATEGORIES)[CategoryKey];

const AFTER_DAYS = Number(process.env.AFTER_DAYS ?? 7);
const LIMIT = Number(process.env.LIMIT ?? 400);
const PER_REPO_DELAY_MS = Number(process.env.PER_REPO_DELAY_MS ?? 1500);
const RETRY_MAX_ATTEMPTS = Number(process.env.RETRY_MAX_ATTEMPTS ?? 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS ?? 10_000);

const requestedCategory = (process.env.CATEGORY ?? 'all').toLowerCase() as CategoryKey | 'all';
const categories: CategoryKey[] =
  requestedCategory === 'all'
    ? Object.keys(CATEGORIES) as CategoryKey[]
    : [requestedCategory];

const invalid = categories.filter((c) => !(c in CATEGORIES));
if (invalid.length > 0) {
  console.error(`[refresh-top] invalid CATEGORY value(s): ${invalid.join(', ')}`);
  console.error(`[refresh-top] valid values: ${Object.keys(CATEGORIES).join(', ')}, all`);
  process.exit(1);
}

let stopping = false;
function installShutdown() {
  process.on('SIGTERM', () => { if (!stopping) { stopping = true; console.log('[refresh-top] received SIGTERM, finishing current step…'); } });
  process.on('SIGINT', () => { if (!stopping) { stopping = true; console.log('[refresh-top] received SIGINT, finishing current step…'); } });
}
installShutdown();

type RepoRow = { owner_login: string; repo_name: string; full_name: string };

async function getTopByCategory(category: CategoryColumn, limit: number): Promise<RepoRow[]> {
  const { rows } = await db.execute<RepoRow>(sql`
    SELECT owner_login, repo_name, full_name
    FROM repo_health
    WHERE scored_at < NOW() - (${AFTER_DAYS}::int * INTERVAL '1 day')
      AND ${sql.raw(category)} IS NOT NULL
    ORDER BY ${sql.raw(category)} DESC NULLS LAST
    LIMIT ${limit}
  `);
  return rows;
}

async function sleepUntilNextReset(): Promise<void> {
  const { rows } = await db.execute<{ reset_time: number | null }>(sql`
    SELECT MIN(reset_time) AS reset_time FROM token_rate_limit WHERE remaining <= 0
  `);
  const resetUnix = rows[0]?.reset_time ?? 0;
  const targetMs = resetUnix > 0 ? resetUnix * 1000 - Date.now() + 5_000 : 60_000;
  const waitMs = Math.min(60 * 60_000, Math.max(60_000, targetMs));
  console.log(`[refresh-top] all tokens exhausted — sleeping ${Math.round(waitMs / 1000)}s`);
  await sleep(waitMs);
}

async function processRepo(owner: string, name: string): Promise<boolean> {
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const metrics = await fetchRepoHealth(owner, name, false);
      if (!metrics) {
        console.log(`[refresh-top] ${owner}/${name} not found — skipping`);
        return false;
      }
      const score = computeContributionScore(metrics);
      await upsertRepoHealth(metrics, score);
      console.log(
        `[refresh-top] ${metrics.fullName} score=${score.score} ` +
          `(resp=${fmt(score.responsiveness)} thr=${fmt(score.throughput)} ` +
          `acc=${fmt(score.acceptance)} new=${fmt(score.newcomer)} live=${fmt(score.liveness)} ` +
          `conf=${score.confidence}${score.gatedReason ? ` GATED:${score.gatedReason}` : ''})`
      );
      return true;
    } catch (e) {
      console.error(
        `[refresh-top] ${owner}/${name} threw (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}):`,
        (e as Error).message
      );
      if (attempt < RETRY_MAX_ATTEMPTS) {
        await sleep(backoffDelay(attempt, RETRY_BASE_DELAY_MS));
      }
    }
  }
  return false;
}

async function processIssues(owner: string, name: string, fullName: string): Promise<void> {
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const issues = await fetchGoodFirstIssues(owner, name, false);
      if (issues.length > 0) {
        await upsertRepoIssues(fullName, issues);
        console.log(`[refresh-top] stored ${issues.length} good-first issues for ${fullName}`);
      }
      return;
    } catch (e) {
      console.error(
        `[refresh-top] issues for ${fullName} threw (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}):`,
        (e as Error).message
      );
      if (attempt < RETRY_MAX_ATTEMPTS) {
        await sleep(backoffDelay(attempt, RETRY_BASE_DELAY_MS));
      }
    }
  }
}

const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(2));

async function main() {
  console.log(
    `[refresh-top] starting (categories=${categories.join(',')}, after=${AFTER_DAYS}d, ` +
      `per_category_limit=${LIMIT}, delay=${PER_REPO_DELAY_MS}ms)`
  );

  let totalProcessed = 0;
  let totalSkipped = 0;
  const processedRepos = new Set<string>();

  for (const category of categories) {
    if (stopping) break;
    const column = CATEGORIES[category];
    console.log(`[refresh-top] --- category: ${category} (${column}) ---`);

    const batch = await getTopByCategory(column, LIMIT);
    if (batch.length === 0) {
      console.log(`[refresh-top] no stale repos for ${category}`);
      continue;
    }

    console.log(`[refresh-top] ${batch.length} stale top repos for ${category}`);

    for (const repo of batch) {
      if (stopping) break;

      try {
        await getBestToken();
      } catch (e) {
        if (e instanceof Error && e.message === 'rate-limited-all-tokens') {
          await sleepUntilNextReset();
          continue;
        }
        throw e;
      }

      const ok = await processRepo(repo.owner_login, repo.repo_name);
      if (ok) {
        totalProcessed++;
        if (!processedRepos.has(repo.full_name)) {
          processedRepos.add(repo.full_name);
          try {
            await getBestToken();
          } catch (e) {
            if (e instanceof Error && e.message === 'rate-limited-all-tokens') {
              await sleepUntilNextReset();
              continue;
            }
            throw e;
          }
          await processIssues(repo.owner_login, repo.repo_name, repo.full_name);
        }
      } else {
        totalSkipped++;
      }
      await sleep(PER_REPO_DELAY_MS);
    }
  }

  console.log(`[refresh-top] done. processed=${totalProcessed} skipped=${totalSkipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[refresh-top] fatal error:', err);
  process.exit(1);
});
