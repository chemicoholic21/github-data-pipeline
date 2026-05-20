-- ============================================================
-- POPULATE ANALYSES FROM GITHUB DATA
-- ============================================================
-- This script computes skill scores and populates the analyses
-- table by analyzing repos and PRs. Runs entirely in PostgreSQL.
--
-- Usage:
--   pnpm run sql:populate-analyses
--   OR run directly in SQL editor
--
-- Performance: ~72,000 users in ~1-2 minutes (vs hours sequential)
-- ============================================================

-- Show count before
SELECT 'Before: ' || COUNT(*)::text || ' rows in analyses' AS status FROM analyses;

-- ============================================================
-- STEP 1: Create temporary table with repo categorization
-- Note: topics is TEXT[] (array), not JSONB
-- ============================================================
DROP TABLE IF EXISTS tmp_repo_categories;

CREATE TEMP TABLE tmp_repo_categories AS
SELECT
  r.owner_login,
  r.repo_name,
  r.stars,
  r.total_prs,
  r.primary_language,
  r.topics,
  -- Categorize based on topics (TEXT[] array) and language
  CASE WHEN (
    EXISTS (SELECT 1 FROM unnest(r.topics) t WHERE t ILIKE ANY(ARRAY['%ai%', '%ml%', '%machine-learning%', '%deep-learning%', '%neural%', '%tensorflow%', '%pytorch%', '%nlp%', '%gpt%', '%llm%', '%langchain%', '%huggingface%']))
    OR r.primary_language IN ('Python', 'Julia', 'R')
  ) THEN true ELSE false END AS is_ai,

  CASE WHEN (
    EXISTS (SELECT 1 FROM unnest(r.topics) t WHERE t ILIKE ANY(ARRAY['%backend%', '%api%', '%server%', '%nodejs%', '%express%', '%django%', '%fastapi%', '%graphql%', '%database%', '%sql%', '%mongodb%']))
    OR r.primary_language IN ('Java', 'Go', 'Rust', 'Ruby', 'PHP', 'C#', 'Scala', 'Kotlin')
  ) THEN true ELSE false END AS is_backend,

  CASE WHEN (
    EXISTS (SELECT 1 FROM unnest(r.topics) t WHERE t ILIKE ANY(ARRAY['%frontend%', '%react%', '%vue%', '%angular%', '%svelte%', '%nextjs%', '%nuxt%', '%tailwind%', '%ui%', '%ux%', '%web%']))
    OR r.primary_language IN ('JavaScript', 'TypeScript', 'CSS', 'HTML')
  ) THEN true ELSE false END AS is_frontend,

  CASE WHEN (
    EXISTS (SELECT 1 FROM unnest(r.topics) t WHERE t ILIKE ANY(ARRAY['%devops%', '%docker%', '%kubernetes%', '%k8s%', '%terraform%', '%aws%', '%gcp%', '%azure%', '%ci-cd%', '%github-actions%', '%jenkins%']))
    OR r.primary_language IN ('Shell', 'HCL', 'Dockerfile')
  ) THEN true ELSE false END AS is_devops,

  CASE WHEN (
    EXISTS (SELECT 1 FROM unnest(r.topics) t WHERE t ILIKE ANY(ARRAY['%data%', '%analytics%', '%data-science%', '%pandas%', '%spark%', '%hadoop%', '%snowflake%', '%dbt%', '%etl%', '%warehouse%', '%bigquery%']))
    OR r.primary_language IN ('SQL', 'R')
  ) THEN true ELSE false END AS is_data,

  -- Score calculation: log(stars + 1) * 10
  (LN(GREATEST(r.stars, 0) + 1) * 10)::real AS star_score
FROM github_repos r;

-- ============================================================
-- STEP 2: Compute PR counts per user per repo
-- ============================================================
DROP TABLE IF EXISTS tmp_user_pr_counts;

CREATE TEMP TABLE tmp_user_pr_counts AS
SELECT
  pr.username,
  pr.repo_name,
  COUNT(*)::int AS pr_count
FROM github_pull_requests pr
WHERE pr.state = 'MERGED'
GROUP BY pr.username, pr.repo_name;

-- ============================================================
-- STEP 3: Compute scores per user (simplified)
-- ============================================================
DROP TABLE IF EXISTS tmp_user_scores;

CREATE TEMP TABLE tmp_user_scores AS
SELECT
  u.username,
  COALESCE(SUM(CASE WHEN rc.is_ai THEN rc.star_score + COALESCE(pc.pr_count, 0) * 5 ELSE 0 END), 0)::real AS ai_score,
  COALESCE(SUM(CASE WHEN rc.is_backend THEN rc.star_score + COALESCE(pc.pr_count, 0) * 5 ELSE 0 END), 0)::real AS backend_score,
  COALESCE(SUM(CASE WHEN rc.is_frontend THEN rc.star_score + COALESCE(pc.pr_count, 0) * 5 ELSE 0 END), 0)::real AS frontend_score,
  COALESCE(SUM(CASE WHEN rc.is_devops THEN rc.star_score + COALESCE(pc.pr_count, 0) * 5 ELSE 0 END), 0)::real AS devops_score,
  COALESCE(SUM(CASE WHEN rc.is_data THEN rc.star_score + COALESCE(pc.pr_count, 0) * 5 ELSE 0 END), 0)::real AS data_score,
  COALESCE(SUM(pc.pr_count), 0)::int AS contribution_count
FROM github_users u
LEFT JOIN tmp_repo_categories rc ON rc.owner_login = u.username
LEFT JOIN tmp_user_pr_counts pc ON pc.username = u.username
  AND pc.repo_name = rc.owner_login || '/' || rc.repo_name
GROUP BY u.username;

-- ============================================================
-- STEP 4: Compute top repos per user (as JSON)
-- ============================================================
DROP TABLE IF EXISTS tmp_user_top_repos;

CREATE TEMP TABLE tmp_user_top_repos AS
SELECT
  username,
  jsonb_agg(repo_data ORDER BY repo_score DESC) FILTER (WHERE rn <= 5) AS top_repos_json
FROM (
  SELECT
    u.username,
    jsonb_build_object(
      'name', rc.repo_name,
      'owner', rc.owner_login,
      'stars', rc.stars,
      'score', (rc.star_score + COALESCE(pc.pr_count, 0) * 5)::real
    ) AS repo_data,
    (rc.star_score + COALESCE(pc.pr_count, 0) * 5)::real AS repo_score,
    ROW_NUMBER() OVER (PARTITION BY u.username ORDER BY (rc.star_score + COALESCE(pc.pr_count, 0) * 5) DESC) AS rn
  FROM github_users u
  INNER JOIN tmp_repo_categories rc ON rc.owner_login = u.username
  LEFT JOIN tmp_user_pr_counts pc ON pc.username = u.username
    AND pc.repo_name = rc.owner_login || '/' || rc.repo_name
) ranked
GROUP BY username;

-- ============================================================
-- STEP 5: Compute languages per user (as JSON)
-- ============================================================
DROP TABLE IF EXISTS tmp_user_languages;

CREATE TEMP TABLE tmp_user_languages AS
SELECT
  owner_login AS username,
  jsonb_object_agg(primary_language, lang_count) AS languages_json
FROM (
  SELECT
    owner_login,
    primary_language,
    COUNT(*)::int AS lang_count
  FROM github_repos
  WHERE primary_language IS NOT NULL
  GROUP BY owner_login, primary_language
) lang_stats
GROUP BY owner_login;

-- ============================================================
-- STEP 6: Extract unique skills from topics (as JSON array)
-- Note: topics is TEXT[] array, use unnest
-- ============================================================
DROP TABLE IF EXISTS tmp_user_skills;

CREATE TEMP TABLE tmp_user_skills AS
SELECT
  owner_login AS username,
  jsonb_agg(DISTINCT topic) AS unique_skills_json
FROM (
  SELECT
    r.owner_login,
    unnest(r.topics) AS topic
  FROM github_repos r
  WHERE r.topics IS NOT NULL AND array_length(r.topics, 1) > 0
) expanded
GROUP BY owner_login;

-- ============================================================
-- STEP 7: Final upsert into analyses
-- ============================================================
INSERT INTO analyses (
  id,
  username,
  total_score,
  ai_score,
  backend_score,
  frontend_score,
  devops_score,
  data_score,
  unique_skills_json,
  top_repos_json,
  languages_json,
  contribution_count,
  cached_at
)
SELECT
  LOWER(s.username) AS id,
  s.username,
  (s.ai_score + s.backend_score + s.frontend_score + s.devops_score + s.data_score)::real AS total_score,
  s.ai_score,
  s.backend_score,
  s.frontend_score,
  s.devops_score,
  s.data_score,
  sk.unique_skills_json,
  tr.top_repos_json,
  l.languages_json,
  s.contribution_count,
  NOW()
FROM tmp_user_scores s
LEFT JOIN tmp_user_skills sk ON sk.username = s.username
LEFT JOIN tmp_user_top_repos tr ON tr.username = s.username
LEFT JOIN tmp_user_languages l ON l.username = s.username
ON CONFLICT (id) DO UPDATE SET
  username = EXCLUDED.username,
  total_score = EXCLUDED.total_score,
  ai_score = EXCLUDED.ai_score,
  backend_score = EXCLUDED.backend_score,
  frontend_score = EXCLUDED.frontend_score,
  devops_score = EXCLUDED.devops_score,
  data_score = EXCLUDED.data_score,
  unique_skills_json = EXCLUDED.unique_skills_json,
  top_repos_json = EXCLUDED.top_repos_json,
  languages_json = EXCLUDED.languages_json,
  contribution_count = EXCLUDED.contribution_count,
  cached_at = NOW();

-- ============================================================
-- CLEANUP: Drop temporary tables
-- ============================================================
DROP TABLE IF EXISTS tmp_repo_categories;
DROP TABLE IF EXISTS tmp_user_pr_counts;
DROP TABLE IF EXISTS tmp_user_scores;
DROP TABLE IF EXISTS tmp_user_top_repos;
DROP TABLE IF EXISTS tmp_user_languages;
DROP TABLE IF EXISTS tmp_user_skills;

-- Show count after
SELECT 'After: ' || COUNT(*)::text || ' rows in analyses' AS status FROM analyses;

-- Show summary
SELECT
  'Summary: ' ||
  COUNT(*)::text || ' total, ' ||
  COUNT(CASE WHEN total_score > 0 THEN 1 END)::text || ' with scores, ' ||
  ROUND(AVG(total_score)::numeric, 2)::text || ' avg score'
  AS status
FROM analyses;
