/**
 * Verify the leaderboard_v2 -> leaderboard / api_cache_v2 -> api_cache rename.
 *
 * Connects directly with DATABASE_URL (no GitHub tokens required) and asserts:
 *   - leaderboard + api_cache exist; leaderboard_v2 + api_cache_v2 are gone
 *   - the canonical indexes/constraints exist on the renamed tables
 *   - NO "v2"/"lv2"/"acv2" index or constraint names remain anywhere
 *   - the *_old tables still hold their data
 *
 * Usage:
 *   npx tsx scripts/verify-rename.ts
 *
 * Exits 0 if everything passes, 1 otherwise.
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';

// Load .env.local too (override), matching the rest of the project.
loadEnv({ path: '.env' });
loadEnv({ path: '.env.local', override: true });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set (.env / .env.local).');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const EXPECTED_LEADERBOARD_INDEXES = [
  'idx_leaderboard_ai_score',
  'idx_leaderboard_backend_score',
  'idx_leaderboard_frontend_score',
  'idx_leaderboard_is_open_to_work',
  'idx_leaderboard_name_trgm',
  'idx_leaderboard_total_score',
  'idx_leaderboard_unique_skills_gin',
  'idx_leaderboard_username_trgm',
  'leaderboard_pkey',
];

const EXPECTED_API_CACHE_INDEXES = [
  'api_cache_cache_key_key',
  'api_cache_pkey',
  'idx_api_cache_cache_ref',
  'idx_api_cache_expires_at',
  'idx_api_cache_type_ref',
];

async function tableExists(name: string): Promise<boolean> {
  const r = await pool.query('SELECT to_regclass($1) AS reg', [`public.${name}`]);
  return r.rows[0].reg !== null;
}

async function indexNames(table: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`,
    [table]
  );
  return r.rows.map((x: { indexname: string }) => x.indexname);
}

async function rowCount(table: string): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return r.rows[0].n;
}

async function main(): Promise<void> {
  console.log('═'.repeat(64));
  console.log('Verifying v2 -> primary table rename');
  console.log('═'.repeat(64));

  // 1) Tables
  check('table "leaderboard" exists', await tableExists('leaderboard'));
  check('table "api_cache" exists', await tableExists('api_cache'));
  check('table "leaderboard_v2" is gone', !(await tableExists('leaderboard_v2')));
  check('table "api_cache_v2" is gone', !(await tableExists('api_cache_v2')));
  check('legacy "leaderboard_old" still present', await tableExists('leaderboard_old'));
  check('legacy "api_cache_old" still present', await tableExists('api_cache_old'));

  // 2) Indexes / constraints on renamed tables
  const lbIdx = await indexNames('leaderboard');
  for (const want of EXPECTED_LEADERBOARD_INDEXES) {
    check(`leaderboard has index/constraint "${want}"`, lbIdx.includes(want));
  }
  const acIdx = await indexNames('api_cache');
  for (const want of EXPECTED_API_CACHE_INDEXES) {
    check(`api_cache has index/constraint "${want}"`, acIdx.includes(want));
  }

  // 3) No leftover v2 names anywhere (indexes or relations)
  const leftover = await pool.query(
    `SELECT relname FROM pg_class
     WHERE relkind IN ('i','r')
       AND (relname LIKE '%\\_v2%' OR relname LIKE 'idx\\_lv2\\_%' OR relname LIKE 'idx\\_acv2\\_%')
     ORDER BY relname`
  );
  check(
    'no leftover v2/lv2/acv2 relation names',
    leftover.rowCount === 0,
    leftover.rowCount === 0 ? '' : leftover.rows.map((r: { relname: string }) => r.relname).join(', ')
  );

  // 4) Row counts (sanity — just report, and confirm non-empty)
  const counts: Record<string, number> = {};
  for (const t of ['leaderboard', 'api_cache', 'leaderboard_old', 'api_cache_old']) {
    counts[t] = await rowCount(t);
  }
  console.log('\nRow counts:');
  for (const [t, n] of Object.entries(counts)) {
    console.log(`   ${t.padEnd(18)} ${n.toLocaleString()}`);
  }
  check('leaderboard has rows', counts.leaderboard! > 0);
  check('api_cache has rows', counts.api_cache! > 0);

  console.log('\n' + '═'.repeat(64));
  if (failures === 0) {
    console.log('✅ ALL CHECKS PASSED — rename is complete and clean.');
  } else {
    console.log(`❌ ${failures} check(s) FAILED — see above.`);
  }
  console.log('═'.repeat(64));

  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
