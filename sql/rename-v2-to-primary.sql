-- ============================================================================
-- RENAME v2 TABLES TO PRIMARY NAMES (remove the "v2"/"v4" concept)
-- ============================================================================
-- Goal:
--   leaderboard_v2  ->  leaderboard
--   api_cache_v2    ->  api_cache
-- ...including every index and constraint, so nothing keeps the v2 naming.
--
-- WHY THE EARLIER ATTEMPTS FAILED
--   The previous `leaderboard`/`api_cache` tables were renamed to
--   `leaderboard_old`/`api_cache_old`, BUT their indexes/constraints kept the
--   original (un-suffixed) names. In PostgreSQL, index and constraint names are
--   unique per schema, so the canonical names we want for the renamed tables
--   were ALREADY taken by the *_old tables:
--       leaderboard_old  owns  idx_leaderboard_*  and  leaderboard_pkey
--       api_cache_old    owns  api_cache_pkey
--   That is why "relation idx_leaderboard_ai_score already exists" appeared.
--
-- THE FIX = TWO PHASES
--   Phase 1: move the *_old tables' index/constraint names into the *_old
--            namespace, freeing the canonical names.
--   Phase 2: rename the (formerly v2) tables' indexes/constraints into the now
--            free canonical names.
--
-- The table renames themselves (leaderboard_v2 -> leaderboard,
-- api_cache_v2 -> api_cache) are assumed ALREADY DONE. If not, uncomment the
-- block right below.
--
-- This whole script is IDEMPOTENT and SAFE TO RE-RUN: each rename only happens
-- when the source exists and the target name is still free.
-- ============================================================================

-- --- (Optional) table renames, only if not already done -------------------
-- DO $$
-- BEGIN
--   IF to_regclass('public.leaderboard_v2') IS NOT NULL
--      AND to_regclass('public.leaderboard') IS NULL THEN
--     ALTER TABLE leaderboard_v2 RENAME TO leaderboard;
--   END IF;
--   IF to_regclass('public.api_cache_v2') IS NOT NULL
--      AND to_regclass('public.api_cache') IS NULL THEN
--     ALTER TABLE api_cache_v2 RENAME TO api_cache;
--   END IF;
-- END $$;

BEGIN;

-- ---------------------------------------------------------------------------
-- INDEX RENAMES (plain, non-constraint indexes)
-- ---------------------------------------------------------------------------
-- Phase 1 entries (move *_old indexes aside) are listed BEFORE the Phase 2
-- entries (rename formerly-v2 indexes into canonical names). Order matters and
-- is preserved by the loop.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN (
    VALUES
      -- Phase 1: leaderboard_old indexes -> *_old namespace
      ('idx_leaderboard_ai_score',        'idx_leaderboard_old_ai_score'),
      ('idx_leaderboard_backend_score',   'idx_leaderboard_old_backend_score'),
      ('idx_leaderboard_frontend_score',  'idx_leaderboard_old_frontend_score'),
      ('idx_leaderboard_is_open_to_work', 'idx_leaderboard_old_is_open_to_work'),
      ('idx_leaderboard_name_trgm',       'idx_leaderboard_old_name_trgm'),
      ('idx_leaderboard_total_score',     'idx_leaderboard_old_total_score'),
      ('idx_leaderboard_username_trgm',   'idx_leaderboard_old_username_trgm'),

      -- Phase 2: leaderboard (formerly v2) indexes -> canonical names
      ('idx_lv2_ai_score',          'idx_leaderboard_ai_score'),
      ('idx_lv2_backend_score',     'idx_leaderboard_backend_score'),
      ('idx_lv2_frontend_score',    'idx_leaderboard_frontend_score'),
      ('idx_lv2_open_to_work',      'idx_leaderboard_is_open_to_work'),
      ('idx_lv2_name_trgm',         'idx_leaderboard_name_trgm'),
      ('idx_lv2_total_score',       'idx_leaderboard_total_score'),
      ('idx_lv2_unique_skills_gin', 'idx_leaderboard_unique_skills_gin'),
      ('idx_lv2_username_trgm',     'idx_leaderboard_username_trgm'),

      -- Phase 2: api_cache (formerly v2) indexes -> canonical names
      -- (api_cache_old already uses idx_api_cache_old_expires_at, so no Phase 1
      --  rename is needed for api_cache.)
      ('idx_acv2_cache_ref',  'idx_api_cache_cache_ref'),
      ('idx_acv2_expires_at', 'idx_api_cache_expires_at'),
      ('idx_acv2_type_ref',   'idx_api_cache_type_ref')
  ) AS t(src, dst)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = r.src AND relkind = 'i')
       AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = r.dst) THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.src, r.dst);
      RAISE NOTICE 'Renamed index % -> %', r.src, r.dst;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- CONSTRAINT RENAMES (PRIMARY KEY / UNIQUE)
-- ---------------------------------------------------------------------------
-- Renaming a constraint also renames its backing index, so these handle the
-- pkey/unique indexes. *_old constraints are moved aside first.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN (
    VALUES
      -- Phase 1: *_old constraints -> *_old namespace
      ('leaderboard_old', 'leaderboard_pkey',           'leaderboard_old_pkey'),
      ('api_cache_old',   'api_cache_pkey',             'api_cache_old_pkey'),

      -- Phase 2: formerly-v2 constraints -> canonical names
      ('leaderboard',     'leaderboard_v2_pkey',        'leaderboard_pkey'),
      ('api_cache',       'api_cache_v2_pkey',          'api_cache_pkey'),
      ('api_cache',       'api_cache_v2_cache_key_key', 'api_cache_cache_key_key')
  ) AS t(tbl, src, dst)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = r.src AND conrelid = ('public.' || r.tbl)::regclass
       )
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = r.dst AND conrelid = ('public.' || r.tbl)::regclass
       ) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', r.tbl, r.src, r.dst);
      RAISE NOTICE 'Renamed constraint %.% -> %', r.tbl, r.src, r.dst;
    END IF;
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATION (read-only — safe to run anytime)
-- ============================================================================

-- 1) Tables: leaderboard + api_cache present; the *_v2 names must be gone.
SELECT 'tables' AS check, table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('leaderboard', 'api_cache', 'leaderboard_old', 'api_cache_old',
                     'leaderboard_v2', 'api_cache_v2')
ORDER BY table_name;

-- 2) leaderboard indexes — expect canonical idx_leaderboard_* + leaderboard_pkey,
--    and ZERO rows containing 'lv2' or 'v2'.
SELECT 'leaderboard indexes' AS check, indexname
FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'leaderboard'
ORDER BY indexname;

-- 3) api_cache indexes — expect canonical idx_api_cache_* + api_cache_pkey +
--    api_cache_cache_key_key, and ZERO rows containing 'acv2' or 'v2'.
SELECT 'api_cache indexes' AS check, indexname
FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'api_cache'
ORDER BY indexname;

-- 4) Hard check: there must be NO leftover v2 index/constraint names anywhere.
SELECT 'leftover v2 relations (should be 0 rows)' AS check, relname
FROM pg_class
WHERE relkind IN ('i', 'r')
  AND (relname LIKE '%\_v2%' OR relname LIKE 'idx\_lv2\_%' OR relname LIKE 'idx\_acv2\_%')
ORDER BY relname;

-- 5) Row counts sanity.
SELECT 'row counts' AS check, 'leaderboard' AS table_name, COUNT(*) AS rows FROM leaderboard
UNION ALL SELECT 'row counts', 'api_cache',       COUNT(*) FROM api_cache
UNION ALL SELECT 'row counts', 'leaderboard_old', COUNT(*) FROM leaderboard_old
UNION ALL SELECT 'row counts', 'api_cache_old',   COUNT(*) FROM api_cache_old;
