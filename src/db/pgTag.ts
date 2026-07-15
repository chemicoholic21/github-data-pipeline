import { Pool } from 'pg';

/**
 * Drop-in replacement for @neondatabase/serverless's `neon()` tagged-template
 * API, backed by the standard `pg` driver so it works against any Postgres
 * (e.g. Supabase) instead of only Neon's HTTP endpoint.
 *
 * Usage is identical to the Neon serverless client:
 *
 *   const sql = createSqlTag(process.env.DATABASE_URL!);
 *   const rows = await sql`SELECT * FROM leaderboard WHERE username = ${name}`;
 *
 * Interpolated `${...}` values are sent as bind parameters ($1, $2, ...), so
 * this is safe against SQL injection exactly like the Neon client was.
 */
export interface SqlTag {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  /** Underlying pool, exposed for graceful shutdown if needed (`await sql.pool.end()`). */
  pool: Pool;
}

export function createSqlTag(connectionString: string): SqlTag {
  const pool = new Pool({ connectionString });

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) text += `$${i + 1}`;
    }
    const result = await pool.query(text, values);
    return result.rows as Record<string, unknown>[];
  }) as SqlTag;

  sql.pool = pool;
  return sql;
}
