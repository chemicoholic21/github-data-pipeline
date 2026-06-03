/**
 * refresh-worker.ts
 *
 * Continuous daemon that refreshes stale GitHub user profiles.
 *
 * How it works:
 *   - while(true) loop, never exits.
 *   - Picks the oldest users whose `github_users.scraped_at` is older than
 *     REFRESH_AFTER_DAYS (default 30 — aligned with the api_cache 30-day TTL).
 *   - Calls runPipeline(username) on each — which uses the shared token pool
 *     via gitHubGraphqlClient (it auto-selects the best-remaining PAT and
 *     writes back GitHub's rate-limit headers after every call).
 *   - When all PATs hit zero, sleeps until the earliest reset_time and resumes.
 *   - When no users are stale, idles 5 minutes and re-checks.
 *
 * Run via:
 *   npm run refresh-worker
 *   (or via deploy/run-worker.sh inside tmux for crash-restart)
 *
 * Tunables (env vars, all optional):
 *   REFRESH_AFTER_DAYS   default 30
 *   REFRESH_BATCH_SIZE   default 200
 *   PER_USER_DELAY_MS    default 1500   (pacing for secondary-rate-limit safety)
 *   IDLE_SLEEP_MS        default 300000 (5 min between empty-stale checks)
 */

import { sql } from 'drizzle-orm';
import { db, pool } from '../lib/db.js';
import { runPipeline } from '../lib/pipeline.js';
import { getBestToken } from '../github/tokenPool.js';

const REFRESH_AFTER_DAYS = Number(process.env.REFRESH_AFTER_DAYS ?? 30);
const BATCH_SIZE = Number(process.env.REFRESH_BATCH_SIZE ?? 200);
const PER_USER_DELAY_MS = Number(process.env.PER_USER_DELAY_MS ?? 1500);
const IDLE_SLEEP_MS = Number(process.env.IDLE_SLEEP_MS ?? 5 * 60_000);
const MIN_SLEEP_MS = 60_000;
const MAX_SLEEP_MS = 60 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Graceful shutdown so SIGTERM (systemctl stop / Ctrl+C) closes the pool cleanly.
let stopping = false;
function installShutdown() {
  const handler = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] received ${sig}, finishing current step and exiting…`);
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

type StaleRow = { username: string; [k: string]: unknown };

async function getStaleBatch(limit: number): Promise<string[]> {
  const { rows } = await db.execute<StaleRow>(sql`
    WITH ranked AS (
      SELECT
        l.username,
        l.total_score,
        gu.scraped_at,
        ROW_NUMBER() OVER (ORDER BY l.total_score DESC) AS rank
      FROM leaderboard l
      LEFT JOIN github_users gu ON gu.username = l.username
    )
    SELECT username
    FROM ranked
    WHERE scraped_at IS NULL
       OR scraped_at < NOW() - (${REFRESH_AFTER_DAYS}::int * INTERVAL '1 day')
    ORDER BY
      (scraped_at IS NULL) DESC,
      scraped_at ASC NULLS FIRST,
      total_score DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => r.username);
}

/**
 * When all PATs are dry, query the earliest reset_time among the exhausted
 * tokens and sleep precisely until then (clamped to [60s, 60min]).
 */
async function sleepUntilNextReset(): Promise<void> {
  const { rows } = await db.execute<{ reset_time: number | null; [k: string]: unknown }>(sql`
    SELECT MIN(reset_time) AS reset_time
    FROM token_rate_limit
    WHERE remaining <= 0
  `);
  const resetUnix = rows[0]?.reset_time ?? 0;
  const targetMs = resetUnix > 0 ? resetUnix * 1000 - Date.now() + 5_000 : MIN_SLEEP_MS;
  const waitMs = Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, targetMs));
  console.log(
    `[worker] all tokens exhausted — sleeping ${Math.round(waitMs / 1000)}s until next reset`,
  );
  await sleep(waitMs);
}

async function main() {
  installShutdown();
  console.log(
    `[worker] starting (refresh_after=${REFRESH_AFTER_DAYS}d, batch=${BATCH_SIZE}, delay=${PER_USER_DELAY_MS}ms)`,
  );

  let totalProcessed = 0;
  let totalSkippedRateLimit = 0;
  const startedAt = Date.now();

  while (!stopping) {
    let batch: string[];
    try {
      batch = await getStaleBatch(BATCH_SIZE);
    } catch (e) {
      const err = e as Error & { cause?: unknown };
      const cause = err.cause instanceof Error ? err.cause.message : String(err.cause ?? '');
      console.error('[worker] stale-batch query failed:', err.message, cause ? `(cause: ${cause})` : '');
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    if (batch.length === 0) {
      const upH = ((Date.now() - startedAt) / 3_600_000).toFixed(1);
      console.log(
        `[worker] caught up (no stale users). processed=${totalProcessed} uptime=${upH}h — idling ${Math.round(IDLE_SLEEP_MS / 1000)}s`,
      );
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    console.log(`[worker] batch of ${batch.length} stale users; oldest first`);

    for (const username of batch) {
      if (stopping) break;

      // Pre-flight: runPipeline swallows errors, so we check the pool BEFORE
      // calling it. If all PATs are dry, sleep until the earliest reset and retry.
      try {
        await getBestToken();
      } catch (e) {
        if (e instanceof Error && e.message === 'rate-limited-all-tokens') {
          totalSkippedRateLimit++;
          await sleepUntilNextReset();
          continue; // retry the same user with a fresh PAT
        }
        throw e; // unknown error → bubble up, let the launcher restart us
      }

      try {
        await runPipeline(username, true);
        totalProcessed++;
      } catch (e) {
        // runPipeline already catches its own errors, but be defensive.
        console.error(`[worker] runPipeline threw for ${username}:`, (e as Error).message);
      }

      await sleep(PER_USER_DELAY_MS);
    }

    if (totalProcessed % 100 < BATCH_SIZE) {
      console.log(
        `[worker] progress: processed=${totalProcessed}, rate-limit-waits=${totalSkippedRateLimit}`,
      );
    }
  }

  console.log('[worker] shutdown — closing pool');
  await pool.end();
}

main().catch((e) => {
  console.error('[worker] fatal', e);
  // Exit non-zero so the launcher (tmux loop / systemd) restarts us.
  process.exit(1);
});
