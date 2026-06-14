import pg from 'pg';
const { Pool } = pg;
// Read the connection string from the environment — never hardcode credentials.
// Run with:  node --env-file=.env repo-activity-trace.mjs
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Run: node --env-file=.env repo-activity-trace.mjs');
  process.exit(1);
}
const pool = new Pool({ connectionString });
const c = await pool.connect();
const q = (s,p=[]) => c.query(s,p).then(r=>r.rows);
const pct = (n,d) => d ? (100*n/d).toFixed(1)+'%' : '0%';

try {
  const now = (await q(`SELECT NOW() AS now`))[0].now;
  console.log('DB time:', now);

  const tot = Number((await q(`SELECT COUNT(*) n FROM github_repos`))[0].n);
  const arch = Number((await q(`SELECT COUNT(*) n FROM github_repos WHERE is_archived`))[0].n);
  const fork = Number((await q(`SELECT COUNT(*) n FROM github_repos WHERE is_fork`))[0].n);
  const nullp = Number((await q(`SELECT COUNT(*) n FROM github_repos WHERE pushed_at IS NULL`))[0].n);
  console.log(`\n=== TOTALS ===`);
  console.log(`total repos:       ${tot.toLocaleString()}`);
  console.log(`archived:          ${arch.toLocaleString()} (${pct(arch,tot)})`);
  console.log(`forks:             ${fork.toLocaleString()} (${pct(fork,tot)})`);
  console.log(`null pushed_at:    ${nullp.toLocaleString()} (${pct(nullp,tot)})`);

  // Activity trace: active -> dead, by last push age
  const bucketCase = `CASE
      WHEN pushed_at IS NULL THEN '9: unknown (no pushed_at)'
      WHEN pushed_at >= NOW() - INTERVAL '30 days'  THEN '1: active   (<30d)'
      WHEN pushed_at >= NOW() - INTERVAL '90 days'  THEN '2: recent   (30-90d)'
      WHEN pushed_at >= NOW() - INTERVAL '180 days' THEN '3: slowing  (90-180d)'
      WHEN pushed_at >= NOW() - INTERVAL '365 days' THEN '4: cooling  (180-365d)'
      WHEN pushed_at >= NOW() - INTERVAL '730 days' THEN '5: dormant  (1-2y)'
      WHEN pushed_at >= NOW() - INTERVAL '1095 days' THEN '6: stale    (2-3y)'
      WHEN pushed_at >= NOW() - INTERVAL '1825 days' THEN '7: abandoned(3-5y)'
      ELSE '8: dead     (>5y)'
    END`;

  console.log(`\n=== ACTIVITY TRACE (all repos, by last push) ===`);
  const rows = await q(`SELECT ${bucketCase} bucket, COUNT(*) n, SUM(stars) stars
                        FROM github_repos GROUP BY bucket ORDER BY bucket`);
  console.log('bucket'.padEnd(28), 'repos'.padStart(12), 'share'.padStart(8), 'stars'.padStart(14));
  for (const r of rows)
    console.log(r.bucket.padEnd(28), Number(r.n).toLocaleString().padStart(12), pct(Number(r.n),tot).padStart(8), Number(r.stars||0).toLocaleString().padStart(14));

  // Same trace, popular repos only (stars>=100) - "valuable" liveness
  const pop = Number((await q(`SELECT COUNT(*) n FROM github_repos WHERE stars>=100`))[0].n);
  console.log(`\n=== ACTIVITY TRACE (popular repos, stars>=100; n=${pop.toLocaleString()}) ===`);
  const prows = await q(`SELECT ${bucketCase} bucket, COUNT(*) n
                         FROM github_repos WHERE stars>=100 GROUP BY bucket ORDER BY bucket`);
  for (const r of prows)
    console.log(r.bucket.padEnd(28), Number(r.n).toLocaleString().padStart(12), pct(Number(r.n),pop).padStart(8));

  // Liveness summary: alive vs dead split at 1 year
  const alive = Number((await q(`SELECT COUNT(*) n FROM github_repos WHERE pushed_at >= NOW()-INTERVAL '365 days'`))[0].n);
  const dead  = Number((await q(`SELECT COUNT(*) n FROM github_repos WHERE pushed_at < NOW()-INTERVAL '365 days'`))[0].n);
  console.log(`\n=== ALIVE vs DEAD (1y cutoff) ===`);
  console.log(`alive (pushed <1y):  ${alive.toLocaleString()} (${pct(alive,tot)})`);
  console.log(`dead  (pushed >1y):  ${dead.toLocaleString()} (${pct(dead,tot)})`);
  console.log(`unknown:             ${nullp.toLocaleString()} (${pct(nullp,tot)})`);

  // NOTE: created_at is never populated by the scraper (0 rows), so active
  // lifespan (created -> last push) cannot be derived from this table.

  // Year-of-last-push histogram (the long tail of death)
  console.log(`\n=== LAST-PUSH BY YEAR ===`);
  const yr = await q(`SELECT EXTRACT(YEAR FROM pushed_at)::int y, COUNT(*) n FROM github_repos
                      WHERE pushed_at IS NOT NULL GROUP BY y ORDER BY y`);
  for (const r of yr) console.log(`  ${r.y}: ${Number(r.n).toLocaleString().padStart(12)}  ${pct(Number(r.n),tot)}`);

} finally { c.release(); await pool.end(); }
