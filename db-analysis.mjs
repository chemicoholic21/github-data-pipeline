import pg from 'pg';
const { Pool } = pg;

// Read the connection string from the environment — never hardcode credentials.
// Run with:  node --env-file=.env db-analysis.mjs   (or export DATABASE_URL first)
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Run: node --env-file=.env db-analysis.mjs');
  process.exit(1);
}

const pool = new Pool({ connectionString });

async function run() {
  const client = await pool.connect();
  try {
    // 1. Row counts for all tables
    console.log("\n=== ROW COUNTS ===");
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    for (const t of tables.rows) {
      const count = await client.query(`SELECT COUNT(*) as cnt FROM "${t.table_name}"`);
      console.log(`${t.table_name}: ${count.rows[0].cnt}`);
    }

    // 2. Sample api_cache row
    console.log("\n=== SAMPLE api_cache ROW ===");
    const apiCache = await client.query(`
      SELECT cache_key,
             pg_column_size(response) as response_size_bytes,
             LEFT(response::text, 500) as response_preview,
             cached_at, expires_at
      FROM api_cache LIMIT 1
    `);
    console.log(JSON.stringify(apiCache.rows[0], null, 2));

    // 3. Sample analyses row
    console.log("\n=== SAMPLE analyses ROW ===");
    const analyses = await client.query(`
      SELECT * FROM analyses WHERE total_score > 0 LIMIT 1
    `);
    console.log(JSON.stringify(analyses.rows[0], null, 2));

    // 4. Full schema for all tables
    console.log("\n=== FULL SCHEMA (columns) ===");
    const cols = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);
    let currentTable = '';
    for (const c of cols.rows) {
      if (c.table_name !== currentTable) {
        console.log(`\n-- ${c.table_name} --`);
        currentTable = c.table_name;
      }
      const nullable = c.is_nullable === 'NO' ? 'NOT NULL' : 'NULL';
      const def = c.column_default ? `DEFAULT ${c.column_default}` : '';
      console.log(`  ${c.column_name}: ${c.data_type} ${nullable} ${def}`);
    }

    // 5. All indexes
    console.log("\n=== ALL INDEXES ===");
    const indexes = await client.query(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);
    for (const i of indexes.rows) {
      console.log(`${i.tablename}: ${i.indexname}`);
      console.log(`  ${i.indexdef}`);
    }

    // 6. All foreign keys
    console.log("\n=== FOREIGN KEYS ===");
    const fks = await client.query(`
      SELECT tc.table_name, kcu.column_name,
             ccu.table_name AS foreign_table_name,
             ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
    `);
    if (fks.rows.length === 0) {
      console.log("No foreign keys found!");
    } else {
      for (const fk of fks.rows) {
        console.log(`${fk.table_name}.${fk.column_name} -> ${fk.foreign_table_name}.${fk.foreign_column_name}`);
      }
    }

    // 7. Leaderboard specifics
    console.log("\n=== LEADERBOARD TABLE ===");
    const lbCols = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'leaderboard'
      ORDER BY ordinal_position
    `);
    console.log("Columns:");
    for (const c of lbCols.rows) {
      const nullable = c.is_nullable === 'NO' ? 'NOT NULL' : 'NULL';
      console.log(`  ${c.column_name}: ${c.data_type} ${nullable}`);
    }

    const lbIndexes = await client.query(`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'leaderboard'
    `);
    console.log("\nIndexes:");
    for (const i of lbIndexes.rows) {
      console.log(`  ${i.indexname}: ${i.indexdef}`);
    }

    const lbCount = await client.query(`SELECT COUNT(*) FROM leaderboard`);
    console.log(`\nRow count: ${lbCount.rows[0].count}`);

    const lbSample = await client.query(`SELECT * FROM leaderboard WHERE total_score > 0 LIMIT 1`);
    console.log("\nSample row:");
    console.log(JSON.stringify(lbSample.rows[0], null, 2));

    // 8. github_users vs users overlap
    console.log("\n=== github_users vs users OVERLAP ===");
    const ghUsersCount = await client.query(`SELECT COUNT(*) FROM github_users`);
    const usersCount = await client.query(`SELECT COUNT(*) FROM users`);
    const overlap = await client.query(`
      SELECT COUNT(*) FROM github_users g
      INNER JOIN users u ON g.username = u.username
    `);
    console.log(`github_users: ${ghUsersCount.rows[0].count}`);
    console.log(`users: ${usersCount.rows[0].count}`);
    console.log(`overlap (same username in both): ${overlap.rows[0].count}`);

    // 9. analyses vs user_scores consistency
    console.log("\n=== analyses vs user_scores CONSISTENCY ===");
    const analysesCount = await client.query(`SELECT COUNT(*) FROM analyses`);
    const userScoresCount = await client.query(`SELECT COUNT(*) FROM user_scores`);
    console.log(`analyses rows: ${analysesCount.rows[0].count}`);
    console.log(`user_scores rows: ${userScoresCount.rows[0].count}`);

    const scoreCompare = await client.query(`
      SELECT a.username, a.total_score as analyses_score, us.total_score as user_scores_score,
             ABS(a.total_score - us.total_score) as diff
      FROM analyses a
      JOIN user_scores us ON a.username = us.username
      WHERE ABS(a.total_score - us.total_score) > 0.01
      LIMIT 5
    `);
    if (scoreCompare.rows.length === 0) {
      console.log("All scores are consistent between tables!");
    } else {
      console.log("Score differences found:");
      console.log(JSON.stringify(scoreCompare.rows, null, 2));
    }

    // 10. github_repos analysis
    console.log("\n=== github_repos TABLE ===");
    const reposCols = await client.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'github_repos'
    `);
    console.log("Columns: " + reposCols.rows.map(r => r.column_name).join(', '));

    const reposCount = await client.query(`SELECT COUNT(*) FROM github_repos`);
    console.log(`Row count: ${reposCount.rows[0].count}`);

    const topicsCheck = await client.query(`
      SELECT repo_name, topics FROM github_repos WHERE topics IS NOT NULL AND array_length(topics, 1) > 0 LIMIT 3
    `);
    console.log("\nSample topics:");
    console.log(JSON.stringify(topicsCheck.rows, null, 2));

    const emptyTopics = await client.query(`
      SELECT COUNT(*) FROM github_repos WHERE topics IS NULL OR array_length(topics, 1) IS NULL
    `);
    console.log(`Repos with empty/null topics: ${emptyTopics.rows[0].count}`);

    const langDist = await client.query(`
      SELECT primary_language, COUNT(*) as cnt
      FROM github_repos
      WHERE primary_language IS NOT NULL
      GROUP BY primary_language
      ORDER BY cnt DESC
      LIMIT 10
    `);
    console.log("\nTop 10 languages:");
    for (const l of langDist.rows) {
      console.log(`  ${l.primary_language}: ${l.cnt}`);
    }

    // 11. Chat readiness
    console.log("\n=== CHAT READINESS ===");
    const usersForChat = await client.query(`SELECT COUNT(*) FROM users WHERE username IS NOT NULL`);
    console.log(`Users with valid usernames (for FK): ${usersForChat.rows[0].count}`);

    // 12. Check for full_name column in github_repos
    console.log("\n=== github_repos full_name CHECK ===");
    const fullNameCol = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'github_repos' AND column_name = 'full_name'
    `);
    console.log(`full_name column exists: ${fullNameCol.rows.length > 0}`);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(console.error);
