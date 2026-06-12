-- PRIMARY ranking: top repositories that are GREAT to contribute to.
-- Reads the scored repo_health table (populated by the compute-repo-health
-- worker via a per-repo scrape). Optional filters: language, min confidence.
-- For the legacy existing-data-only proxy see rank-contribution-friendly_old.sql.
--
-- Usage:
--   npx tsx src/scripts/run-sql.ts rank-contribution-friendly

SELECT
    full_name,
    primary_language                       AS language,
    stars,
    contribution_score                     AS score,
    ROUND(confidence::numeric, 2)          AS confidence,
    ROUND(median_first_review_hours::numeric, 1) AS first_review_hrs,
    ROUND(median_merge_hours::numeric, 1)        AS merge_hrs,
    ROUND(acceptance_rate::numeric, 2)           AS accept_rate,
    ROUND(external_merged_ratio::numeric, 2)     AS external_ratio,
    good_first_issues                      AS gfi,
    has_contributing                       AS contributing,
    open_pr_count                          AS open_prs,
    pushed_at::date                        AS last_push
FROM repo_health
WHERE contribution_score > 0          -- excludes archived / gated / too-small
  AND confidence >= 0.4               -- enough signal to trust the ranking
  -- AND primary_language = 'TypeScript'   -- uncomment to filter by stack
ORDER BY contribution_score DESC, confidence DESC, stars DESC
LIMIT 100;
