import 'dotenv/config';
import { pool } from '../src/db/dbClient.js';

async function main() {
  const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'github_users'");
  console.log("Columns of github_users:", res.rows);
  await pool.end();
}

main().catch(console.error);
