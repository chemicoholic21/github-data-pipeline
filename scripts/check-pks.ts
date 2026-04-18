import 'dotenv/config';
import { pool } from '../src/db/dbClient.js';

async function main() {
  const tables = ['github_users', 'github_repos', 'github_pull_requests', 'user_repo_scores', 'user_scores'];
  for (const table of tables) {
    const res = await pool.query(`
      SELECT
          tc.constraint_name, kcu.column_name, tc.constraint_type
      FROM
          information_schema.table_constraints AS tc
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = '${table}' AND tc.constraint_type = 'PRIMARY KEY'
    `);
    console.log(`PK of ${table}:`, res.rows);
  }
  await pool.end();
}

main().catch(console.error);
