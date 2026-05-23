-- =============================================================================
-- V5: Topic Search Optimization
-- =============================================================================
-- Problem: 90% of github_repos have empty topics array (1.95M empty vs 225K with data)
-- Current query unnests 2.1M rows then filters - extremely slow for autocomplete
--
-- Solution: Materialized view with pre-aggregated topic counts + trigram index
--
-- Data summary:
--   - 2.17M repos total, only 225K have topics
--   - 34,887 unique topics with 3+ repos
--   - 28 skills defined, all have matching repo topics
--   - Expected query time: <50ms (vs 1.1s+ without MV)
-- =============================================================================

-- 1. Create materialized view for repo topic counts
-- Only includes repos with actual topics (225K rows → ~35K unique topics)
CREATE MATERIALIZED VIEW IF NOT EXISTS repo_topic_counts AS
SELECT
  topic,
  COUNT(*) as repo_count
FROM github_repos, unnest(topics) as topic
WHERE topics IS NOT NULL
  AND topics != '{}'
  AND array_length(topics, 1) > 0
GROUP BY topic
HAVING COUNT(*) >= 3;  -- Only topics appearing in 3+ repos

-- 2. Add trigram index for fast ILIKE search
CREATE INDEX IF NOT EXISTS idx_rtc_topic_trgm
ON repo_topic_counts USING GIN (topic gin_trgm_ops);

-- 3. Add btree index for sorting by count
CREATE INDEX IF NOT EXISTS idx_rtc_repo_count
ON repo_topic_counts (repo_count DESC);

-- 4. Create combined search view (skills + topics in one place)
-- Skills take priority - excludes repo topics that match any skill's match_topics
CREATE MATERIALIZED VIEW IF NOT EXISTS skill_topic_search AS
WITH skill_counts AS (
  -- Skills from user_skill_scores (128K rows, 28 skills)
  SELECT
    s.slug as topic,
    s.display_name as label,
    'skill' as source,
    s.category,
    COUNT(uss.username) as user_count
  FROM skills s
  LEFT JOIN user_skill_scores uss ON uss.skill_slug = s.slug
  GROUP BY s.slug, s.display_name, s.category
),
-- Get all topics that are covered by skills (via match_topics)
skill_covered_topics AS (
  SELECT DISTINCT unnest(match_topics) as covered_topic FROM skills
),
repo_topics AS (
  -- Topics from repos NOT covered by any skill's match_topics
  SELECT
    r.topic,
    r.topic as label,
    'repo' as source,
    'topic' as category,
    r.repo_count as user_count
  FROM repo_topic_counts r
  WHERE r.topic NOT IN (SELECT covered_topic FROM skill_covered_topics)
)
SELECT * FROM skill_counts
UNION ALL
SELECT * FROM repo_topics;

-- 5. Add trigram indexes on combined view
CREATE INDEX IF NOT EXISTS idx_sts_topic_trgm
ON skill_topic_search USING GIN (topic gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_sts_label_trgm
ON skill_topic_search USING GIN (label gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_sts_user_count
ON skill_topic_search (user_count DESC);

-- 6. Add unique index to support CONCURRENTLY refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_sts_topic_source
ON skill_topic_search (topic, source);

-- =============================================================================
-- REFRESH COMMANDS (run periodically via cron, e.g., daily)
-- =============================================================================
-- REFRESH MATERIALIZED VIEW CONCURRENTLY repo_topic_counts;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY skill_topic_search;

-- =============================================================================
-- OPTIMIZED QUERY (use this instead of the slow unnest query)
-- =============================================================================
-- SELECT topic, label, source, user_count
-- FROM skill_topic_search
-- WHERE topic ILIKE '%' || $1 || '%'
--    OR label ILIKE '%' || $1 || '%'
-- ORDER BY user_count DESC, label ASC
-- LIMIT 20;
--
-- Expected performance: <50ms (vs 1.5s+ before)
-- =============================================================================
