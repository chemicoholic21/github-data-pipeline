import 'dotenv/config';
import { pool } from '../src/db/dbClient.js';

async function main() {
  const tables = ['github_repos', 'github_pull_requests', 'user_repo_scores', 'user_scores'];
  for (const table of tables) {
    const res = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table}'`);
    console.log(`Columns of ${table}:`, res.rows);
  }
  await pool.end();
}

main().catch(console.error);
