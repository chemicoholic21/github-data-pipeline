-- ============================================================================
-- RENAME analyses_old -> analyses
-- ============================================================================
-- The UI / API (e.g. /api/analyze/[username], /api/github/search) and
-- sql/populate-leaderboard.sql query a table named `analyses`, but the data
-- currently lives in `analyses_old`. This restores the primary name.
--
-- Unlike leaderboard/api_cache, NO index juggling is needed: analyses_old's
-- indexes are already canonically named (`analyses_pkey`, `idx_analyses_total_score`),
-- and there is no other `analyses` relation to collide with.
--
-- ⚠️ RUN AS THE TABLE OWNER (e.g. `neondb_owner` in the Neon SQL editor).
-- IDEMPOTENT: only renames when analyses_old exists and analyses does not.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.analyses_old') IS NOT NULL
     AND to_regclass('public.analyses') IS NULL THEN
    ALTER TABLE analyses_old RENAME TO analyses;
    RAISE NOTICE 'Renamed analyses_old -> analyses';
  ELSE
    RAISE NOTICE 'No-op: analyses already present or analyses_old missing';
  END IF;
END $$;

-- --- Verification (read-only) ----------------------------------------------
SELECT 'analyses exists?' AS check, to_regclass('public.analyses') IS NOT NULL AS ok;
SELECT 'analyses indexes' AS check, indexname
FROM pg_indexes WHERE schemaname='public' AND tablename='analyses' ORDER BY indexname;
SELECT 'analyses rows' AS check, COUNT(*) AS rows FROM analyses;
