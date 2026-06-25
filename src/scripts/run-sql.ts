/**
 * Generic SQL Runner Script
 *
 * Executes SQL files directly against the database.
 * Much faster than TypeScript loops for bulk operations.
 *
 * Usage:
 *   pnpm run sql <script-name>
 *   pnpm run sql:populate-leaderboard
 *   pnpm run sql:populate-analyses
 *
 * Examples:
 *   npx tsx src/scripts/run-sql.ts populate-leaderboard
 *   npx tsx src/scripts/run-sql.ts populate-analyses
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/dbClient.js';
import { sql } from 'drizzle-orm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SQL_DIR = join(__dirname, '../../sql');

async function runSqlFile(scriptName: string): Promise<void> {
  const startTime = Date.now();

  // Normalize script name
  const fileName = scriptName.endsWith('.sql') ? scriptName : `${scriptName}.sql`;
  const filePath = join(SQL_DIR, fileName);

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                    SQL SCRIPT RUNNER                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log();

  // Check if file exists
  if (!existsSync(filePath)) {
    console.error(`❌ SQL file not found: ${filePath}`);
    console.log();
    console.log('Available scripts:');
    listAvailableScripts();
    process.exit(1);
  }

  console.log(`📄 Script: ${fileName}`);
  console.log(`📁 Path: ${filePath}`);
  console.log();

  try {
    // Read SQL file
    const sqlContent = readFileSync(filePath, 'utf-8');

    // Count statements (rough estimate)
    const statementCount = sqlContent.split(';').filter((s) => s.trim()).length;
    console.log(`📊 Statements: ~${statementCount}`);
    console.log();
    console.log('─'.repeat(70));
    console.log('Executing...');
    console.log('─'.repeat(70));
    console.log();

    // Execute the SQL
    const result = await db.execute(sql.raw(sqlContent));

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log();
    console.log('─'.repeat(70));
    console.log(`✅ Completed in ${duration}s`);
    console.log('─'.repeat(70));

    // Try to show result if available
    if (result && Array.isArray(result) && result.length > 0) {
      console.log();
      console.log('Result:');
      console.table(result);
    }
  } catch (error: unknown) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const errorMsg = error instanceof Error ? error.message : String(error);

    console.error();
    console.error('─'.repeat(70));
    console.error(`❌ Failed after ${duration}s`);
    console.error('─'.repeat(70));
    console.error();
    console.error('Error:', errorMsg);

    if (error instanceof Error && error.stack) {
      console.error();
      console.error('Stack trace:');
      console.error(error.stack);
    }

    process.exit(1);
  }
}

function listAvailableScripts(): void {
  try {
    const files = readdirSync(SQL_DIR)
      .filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => `  - ${f.replace('.sql', '')}`);

    if (files.length > 0) {
      console.log(files.join('\n'));
    } else {
      console.log('  (no SQL scripts found)');
    }
  } catch {
    console.log('  (sql directory not found)');
  }
}

// Main
const scriptName = process.argv[2];

if (!scriptName) {
  console.log('Usage: npx tsx src/scripts/run-sql.ts <script-name>');
  console.log();
  console.log('Available scripts:');
  listAvailableScripts();
  process.exit(1);
}

runSqlFile(scriptName)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
