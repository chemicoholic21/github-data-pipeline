import 'dotenv/config';
import { pool } from '../src/db/dbClient.js';

async function main() {
  const res = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  console.log("Existing tables:", res.rows.map(r => r.table_name));
  await pool.end();
}

main().catch(console.error);
