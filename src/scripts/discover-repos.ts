/**
 * discover-repos.ts
 *
 * Discovers NEW open-source repositories worth contributing to, directly from
 * GitHub's repository search API — independent of which developers we've
 * scraped. This is the missing "top of funnel" that keeps the candidate pool
 * fresh so the leaderboard isn't stuck on the same handful of repos.
 *
 * What it does:
 *   - Rotates through a matrix of health-oriented search queries (topic x
 *     star-band, plus newcomer-friendly language queries), biased toward
 *     RECENTLY-ACTIVE repos (pushed within DISCOVER_RECENT_DAYS) so stale /
 *     abandoned projects don't get surfaced.
 *   - Inserts brand-new repos into github_repos (ON CONFLICT DO NOTHING).
 *   - Persists a rotation cursor to a file so each scheduled run continues where
 *     the last one left off and eventually covers the whole matrix, then wraps.
 *
 * It intentionally does NOT score repos — that's compute-repo-health's job. The
 * intended pipeline is:
 *     discover-repos  ->  github_repos  ->  compute-repo-health  ->  repo_health
 *
 * Run:
 *   npm run discover-repos                    # daemon, rotates forever
 *   ONESHOT=1 npm run discover-repos          # one rotation chunk, then exit
 *
 * Tunables (env, all optional):
 *   DISCOVER_MIN_STARS         default 100    floor for "worth contributing to"
 *   DISCOVER_RECENT_DAYS       default 180    only repos pushed within this window
 *   DISCOVER_QUERIES_PER_RUN   default 6      how many queries per rotation chunk
 *   DISCOVER_PAGES_PER_QUERY   default 2      search pages per query (100 repos each, max 10)
 *   DISCOVER_PAGE_DELAY_MS     default 2500   pacing (search API allows ~30 req/min)
 *   DISCOVER_CURSOR_FILE       default ./.discover-cursor
 *   IDLE_SLEEP_MS              default 300000 sleep after a full matrix pass (daemon)
 *   ONESHOT                    default 0      1 = one chunk then exit
 */

import fs from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import { getBestToken, updateTokenRateLimit, markTokenExhausted } from '../github/tokenPool.js';
import { upsertDiscoveredRepos, type DiscoveredRepo } from '../db/upserts.js';
import { sleep } from '../utils/async.js';

const MIN_STARS = Number(process.env.DISCOVER_MIN_STARS ?? 100);
const RECENT_DAYS = Number(process.env.DISCOVER_RECENT_DAYS ?? 180);
const QUERIES_PER_RUN = Number(process.env.DISCOVER_QUERIES_PER_RUN ?? 6);
const PAGES_PER_QUERY = Math.min(10, Number(process.env.DISCOVER_PAGES_PER_QUERY ?? 2));
const PER_PAGE = 100;
const PAGE_DELAY_MS = Number(process.env.DISCOVER_PAGE_DELAY_MS ?? 2500);
const IDLE_SLEEP_MS = Number(process.env.IDLE_SLEEP_MS ?? 5 * 60_000);
const ONESHOT = process.env.ONESHOT === '1';
const CURSOR_FILE = process.env.DISCOVER_CURSOR_FILE ?? path.resolve(process.cwd(), '.discover-cursor');

/** Domains people actually want to contribute to, across the ecosystem. */
const TOPICS = [
  'artificial-intelligence',
  'machine-learning',
  'llm',
  'deep-learning',
  'nlp',
  'data-science',
  'data-engineering',
  'web',
  'frontend',
  'backend',
  'api',
  'database',
  'devops',
  'kubernetes',
  'cloud',
  'security',
  'cli',
  'mobile',
  'react',
  'nextjs',
  'rust',
  'golang',
  'blockchain',
  'game-development',
];

/** Star bands spread coverage past the search API's 1000-results-per-query cap. */
const STAR_BANDS = ['100..500', '500..2000', '2000..10000', '>10000'];

/** Languages we specifically probe for newcomer-friendly (good-first-issue) repos. */
const LANGS = [
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'c++',
  'ruby',
  'kotlin',
  'swift',
  'c#',
  'php',
];

type SearchSort = 'updated' | 'stars' | 'help-wanted-issues';
interface DiscoveryQuery {
  label: string;
  q: string;
  sort: SearchSort;
}

function recentSince(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Build the full, deterministic rotation matrix of search queries. Deterministic
 * ordering is important: the persisted cursor indexes into this list, so runs
 * must always produce the same sequence.
 */
function buildQueries(): DiscoveryQuery[] {
  const since = recentSince(RECENT_DAYS);
  const common = `pushed:>${since} fork:false archived:false`;
  const queries: DiscoveryQuery[] = [];

  // 1) topic x star-band, sorted by most recently updated (freshness first).
  for (const topic of TOPICS) {
    for (const band of STAR_BANDS) {
      queries.push({
        label: `topic:${topic} stars:${band}`,
        q: `topic:${topic} stars:${band} ${common}`,
        sort: 'updated',
      });
    }
  }

  // 2) per-language newcomer-friendly repos (open good-first-issues), sorted so
  //    the most beginner-welcoming surface first.
  for (const lang of LANGS) {
    queries.push({
      label: `newcomer ${lang}`,
      q: `language:${lang} good-first-issues:>=3 stars:>${MIN_STARS} ${common}`,
      sort: 'help-wanted-issues',
    });
  }

  // 3) a broad newcomer sweep across all languages.
  queries.push({
    label: 'broad good-first-issue',
    q: `good-first-issues:>5 stars:>${MIN_STARS} ${common}`,
    sort: 'updated',
  });

  return queries;
}

function readCursor(total: number): number {
  try {
    const raw = fs.readFileSync(CURSOR_FILE, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 0) return n % total;
  } catch {
    /* no cursor yet — start at 0 */
  }
  return 0;
}

function writeCursor(n: number): void {
  try {
    fs.writeFileSync(CURSOR_FILE, String(n), 'utf8');
  } catch (e) {
    console.warn(`[discover] could not persist cursor to ${CURSOR_FILE}:`, (e as Error).message);
  }
}

let stopping = false;
function installShutdown(): void {
  const handler = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[discover] received ${sig}, finishing current step and exiting…`);
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

interface HttpError extends Error {
  status?: number;
  headers?: Record<string, string | undefined>;
}

/**
 * Run one search query across up to PAGES_PER_QUERY pages, upserting new repos.
 * Returns the count of brand-new repos inserted.
 */
async function runQuery(query: DiscoveryQuery): Promise<number> {
  let inserted = 0;

  for (let page = 1; page <= PAGES_PER_QUERY && !stopping; page++) {
    // Acquire a token (rotating past exhausted ones); sleep+retry if all dry.
    let tokenInfo;
    try {
      tokenInfo = await getBestToken();
    } catch (e) {
      if (e instanceof Error && e.message === 'rate-limited-all-tokens') {
        console.log('[discover] all tokens exhausted — sleeping 60s');
        await sleep(60_000);
        page--; // retry this page after sleeping
        continue;
      }
      throw e;
    }

    try {
      const octokit = new Octokit({ auth: tokenInfo.token });
      const { data, headers } = await octokit.search.repos({
        q: query.q,
        sort: query.sort,
        order: 'desc',
        per_page: PER_PAGE,
        page,
      });

      // Record this token's remaining SEARCH quota into the shared pool (same
      // convention bulk-discover uses for search.users).
      const remaining = Number.parseInt(headers['x-ratelimit-remaining'] ?? '0', 10);
      const resetTime = Number.parseInt(headers['x-ratelimit-reset'] ?? '0', 10);
      await updateTokenRateLimit(tokenInfo.index, remaining, resetTime);

      const items = data.items ?? [];
      if (items.length === 0) break; // no more results for this query

      const repos: DiscoveredRepo[] = items
        .filter((r) => r.owner?.login && r.name)
        .map((r) => ({
          name: r.name,
          ownerLogin: r.owner!.login,
          description: r.description ?? null,
          primaryLanguage: r.language ?? null,
          stars: r.stargazers_count ?? 0,
          forks: r.forks_count ?? 0,
          isFork: r.fork ?? false,
          isArchived: r.archived ?? false,
          topics: r.topics ?? [],
          createdAt: r.created_at ?? null,
          pushedAt: r.pushed_at ?? null,
        }));

      inserted += await upsertDiscoveredRepos(repos);

      // If the API returned a short page, we've reached the end of this query.
      if (items.length < PER_PAGE) break;

      await sleep(PAGE_DELAY_MS);
    } catch (e) {
      const err = e as HttpError;
      // 403 = primary/secondary rate limit; mark token and retry the same page.
      if (err.status === 403 || err.status === 429) {
        const reset = Number.parseInt(err.headers?.['x-ratelimit-reset'] ?? '0', 10);
        console.log(`[discover] token ${tokenInfo.index} rate-limited on "${query.label}" — rotating`);
        await markTokenExhausted(tokenInfo.index, reset);
        page--; // retry this page with a different token
        await sleep(2_000);
        continue;
      }
      // 422 can mean two very different things:
      //  (a) the token's ACCOUNT is flagged as spammy -> its search is blocked.
      //      Park that token and rotate to another account instead of aborting.
      //  (b) a genuine query problem / paging beyond the first 1000 results ->
      //      nothing more to fetch for this query, so stop.
      if (err.status === 422) {
        const body =
          `${err.message} ${JSON.stringify((err as { response?: { data?: unknown } }).response?.data ?? '')}`.toLowerCase();
        if (body.includes('spammy') || body.includes('flagged')) {
          console.log(
            `[discover] token ${tokenInfo.index}'s account is flagged for search — parking it and rotating`
          );
          await markTokenExhausted(tokenInfo.index, 0); // parked ~1h; pool skips it
          page--; // retry this page with a different account
          await sleep(1_000);
          continue;
        }
        console.log(`[discover] "${query.label}" page ${page} rejected (422) — ending query`);
        break;
      }
      console.error(`[discover] "${query.label}" page ${page} error:`, err.message);
      break;
    }
  }

  return inserted;
}

async function processChunk(queries: DiscoveryQuery[], startCursor: number): Promise<number> {
  let totalInserted = 0;
  for (let i = 0; i < QUERIES_PER_RUN && !stopping; i++) {
    const idx = (startCursor + i) % queries.length;
    const query = queries[idx]!;
    console.log(`[discover] [${idx + 1}/${queries.length}] ${query.label}`);
    const added = await runQuery(query);
    totalInserted += added;
    console.log(`[discover]   -> ${added} new repos (running total ${totalInserted})`);
  }
  return totalInserted;
}

async function main(): Promise<void> {
  installShutdown();
  const queries = buildQueries();
  console.log(
    `[discover] starting (min_stars=${MIN_STARS}, recent=${RECENT_DAYS}d, ` +
      `queries/run=${QUERIES_PER_RUN}, pages/query=${PAGES_PER_QUERY}, ` +
      `matrix=${queries.length} queries, oneshot=${ONESHOT})`
  );

  let cursor = readCursor(queries.length);
  let grandTotal = 0;

  do {
    const startCursor = cursor;
    const inserted = await processChunk(queries, startCursor);
    grandTotal += inserted;

    cursor = (startCursor + QUERIES_PER_RUN) % queries.length;
    writeCursor(cursor);

    // Detect a full wrap-around of the matrix to pace the daemon.
    const wrapped = startCursor + QUERIES_PER_RUN >= queries.length;
    if (!ONESHOT && !stopping && wrapped) {
      console.log(`[discover] completed a full matrix pass — sleeping ${IDLE_SLEEP_MS / 1000}s`);
      await sleep(IDLE_SLEEP_MS);
    }
  } while (!ONESHOT && !stopping);

  console.log(`[discover] done. new repos inserted this run: ${grandTotal}. next cursor=${cursor}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[discover] fatal error:', err);
  process.exit(1);
});
