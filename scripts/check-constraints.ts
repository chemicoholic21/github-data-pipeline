import 'dotenv/config';
import { pool } from '../src/db/dbClient.js';

async function main() {
  const res = await pool.query(`
    SELECT
        tc.constraint_name, tc.table_name, kcu.column_name, tc.constraint_type
    FROM
        information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = 'github_repos'
  `);
  console.log("Constraints of github_repos:", res.rows);
  await pool.end();
}

main().catch(console.error);
