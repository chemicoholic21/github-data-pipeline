-- ============================================================
-- POPULATE LEADERBOARD FROM CACHED DATA
-- ============================================================
-- This script populates the leaderboard table by joining
-- github_users with analyses data. Runs entirely in PostgreSQL
-- with no Node.js round-trips.
--
-- Usage:
--   pnpm run sql:populate-leaderboard
--   OR run directly in SQL editor
--
-- Performance: ~72,000 users in ~30 seconds (vs 30 hours sequential)
-- ============================================================

-- Show count before
SELECT 'Before: ' || COUNT(*)::text || ' rows in leaderboard' AS status FROM leaderboard;

-- Main upsert operation
INSERT INTO leaderboard (
  username,
  name,
  avatar_url,
  total_score,
  ai_score,
  backend_score,
  frontend_score,
  devops_score,
  data_score,
  unique_skills_json,
  company,
  blog,
  location,
  email,
  bio,
  twitter_username,
  linkedin,
  hireable,
  updated_at
)
SELECT
  u.username,
  u.name,
  u.avatar_url,
  COALESCE(a.total_score, 0),
  COALESCE(a.ai_score, 0),
  COALESCE(a.backend_score, 0),
  COALESCE(a.frontend_score, 0),
  COALESCE(a.devops_score, 0),
  COALESCE(a.data_score, 0),
  a.unique_skills_json,
  u.company,
  u.blog,
  u.location,
  u.email,
  u.bio,
  u.twitter_username,
  a.linkedin,
  COALESCE(u.hireable, false),
  NOW()
FROM github_users u
LEFT JOIN analyses a ON LOWER(a.username) = LOWER(u.username)
ON CONFLICT (username) DO UPDATE SET
  name = EXCLUDED.name,
  avatar_url = EXCLUDED.avatar_url,
  total_score = EXCLUDED.total_score,
  ai_score = EXCLUDED.ai_score,
  backend_score = EXCLUDED.backend_score,
  frontend_score = EXCLUDED.frontend_score,
  devops_score = EXCLUDED.devops_score,
  data_score = EXCLUDED.data_score,
  unique_skills_json = EXCLUDED.unique_skills_json,
  company = EXCLUDED.company,
  blog = EXCLUDED.blog,
  location = EXCLUDED.location,
  email = EXCLUDED.email,
  bio = EXCLUDED.bio,
  twitter_username = EXCLUDED.twitter_username,
  linkedin = EXCLUDED.linkedin,
  hireable = EXCLUDED.hireable,
  updated_at = NOW();

-- Show count after
SELECT 'After: ' || COUNT(*)::text || ' rows in leaderboard' AS status FROM leaderboard;

-- Show summary stats
SELECT
  'Summary: ' ||
  COUNT(*)::text || ' total, ' ||
  COUNT(CASE WHEN total_score > 0 THEN 1 END)::text || ' with scores, ' ||
  COUNT(CASE WHEN total_score = 0 THEN 1 END)::text || ' without scores'
  AS status
FROM leaderboard;
