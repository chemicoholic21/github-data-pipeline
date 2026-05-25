-- ============================================================================
-- RENAME v2 OBJECTS TO PRIMARY NAMES — PLAIN VERSION (no PL/pgSQL / DO block)
-- ============================================================================
-- Use this if your SQL editor struggles with the DO-block version in
-- rename-v2-to-primary.sql. It is a straight list of ALTER statements, run in
-- the correct order, wrapped in a single transaction (all-or-nothing).
--
-- ⚠️ RUN AS THE TABLE OWNER (e.g. `neondb_owner` in the Neon SQL editor).
--    A non-owner role fails with "must be owner of index ...".
--
-- ⚠️ NOT idempotent: run it exactly once, on a database where the table renames
--    (leaderboard_v2 -> leaderboard, api_cache_v2 -> api_cache) are already done
--    and the indexes/constraints still carry their v2 names. If a statement
--    errors, the whole transaction rolls back and nothing changes.
--
-- The object names below were taken directly from the live database.
-- ============================================================================

BEGIN;

-- --- Phase 1: free the canonical names currently held by the *_old tables ---
ALTER INDEX idx_leaderboard_ai_score        RENAME TO idx_leaderboard_old_ai_score;
ALTER INDEX idx_leaderboard_backend_score   RENAME TO idx_leaderboard_old_backend_score;
ALTER INDEX idx_leaderboard_frontend_score  RENAME TO idx_leaderboard_old_frontend_score;
ALTER INDEX idx_leaderboard_is_open_to_work RENAME TO idx_leaderboard_old_is_open_to_work;
ALTER INDEX idx_leaderboard_name_trgm       RENAME TO idx_leaderboard_old_name_trgm;
ALTER INDEX idx_leaderboard_total_score     RENAME TO idx_leaderboard_old_total_score;
ALTER INDEX idx_leaderboard_username_trgm   RENAME TO idx_leaderboard_old_username_trgm;
ALTER TABLE leaderboard_old RENAME CONSTRAINT leaderboard_pkey TO leaderboard_old_pkey;
ALTER TABLE api_cache_old   RENAME CONSTRAINT api_cache_pkey   TO api_cache_old_pkey;

-- --- Phase 2: rename the formerly-v2 objects into the canonical names --------
ALTER INDEX idx_lv2_ai_score          RENAME TO idx_leaderboard_ai_score;
ALTER INDEX idx_lv2_backend_score     RENAME TO idx_leaderboard_backend_score;
ALTER INDEX idx_lv2_frontend_score    RENAME TO idx_leaderboard_frontend_score;
ALTER INDEX idx_lv2_open_to_work      RENAME TO idx_leaderboard_is_open_to_work;
ALTER INDEX idx_lv2_name_trgm         RENAME TO idx_leaderboard_name_trgm;
ALTER INDEX idx_lv2_total_score       RENAME TO idx_leaderboard_total_score;
ALTER INDEX idx_lv2_unique_skills_gin RENAME TO idx_leaderboard_unique_skills_gin;
ALTER INDEX idx_lv2_username_trgm     RENAME TO idx_leaderboard_username_trgm;
ALTER TABLE leaderboard RENAME CONSTRAINT leaderboard_v2_pkey TO leaderboard_pkey;

ALTER INDEX idx_acv2_cache_ref  RENAME TO idx_api_cache_cache_ref;
ALTER INDEX idx_acv2_expires_at RENAME TO idx_api_cache_expires_at;
ALTER INDEX idx_acv2_type_ref   RENAME TO idx_api_cache_type_ref;
ALTER TABLE api_cache RENAME CONSTRAINT api_cache_v2_pkey          TO api_cache_pkey;
ALTER TABLE api_cache RENAME CONSTRAINT api_cache_v2_cache_key_key TO api_cache_cache_key_key;

COMMIT;

-- ============================================================================
-- VERIFICATION (read-only)
-- ============================================================================
SELECT 'leaderboard indexes' AS check, indexname
FROM pg_indexes WHERE schemaname='public' AND tablename='leaderboard' ORDER BY indexname;

SELECT 'api_cache indexes' AS check, indexname
FROM pg_indexes WHERE schemaname='public' AND tablename='api_cache' ORDER BY indexname;

-- Must return 0 rows:
SELECT 'leftover v2 relations (should be 0 rows)' AS check, relname
FROM pg_class
WHERE relkind IN ('i','r')
  AND (relname LIKE '%\_v2%' OR relname LIKE 'idx\_lv2\_%' OR relname LIKE 'idx\_acv2\_%')
ORDER BY relname;
