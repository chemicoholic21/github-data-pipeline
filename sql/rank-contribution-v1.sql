-- v1 ranking: best-effort "active & reachable" repositories using ONLY data
-- already in the DB (no new scraping). This is an ACTIVITY/LIVENESS + REACH
-- score, NOT a true contribution-friendliness score:
--   * merge timing comes from github_pull_requests, which only stores MERGED
--     PRs authored by tracked users (often maintainers) -> optimistic bias.
--   * no review latency, acceptance rate, or newcomer signals are available.
-- Use sql/rank-contribution-friendly.sql (v2) once repo_health is populated.
--
-- Components (each normalized 0..1):
--   recency  = exp(-days_since_push / 90)               liveness
--   reach    = ln(1+stars) / ln(1+100000)               popularity
--   merge    = 1 / (1 + median_merge_hours / 72)        biased throughput proxy
-- Final = 100 * (0.45*recency + 0.30*reach + 0.25*merge), merge only when
-- we have >= 5 sampled PRs (else recency/reach reweighted to 0.6/0.4).

WITH pr_stats AS (
    SELECT
        full_name,
        COUNT(*)::int AS pr_sample,
        percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (merged_at - created_at)) / 3600.0
        ) AS median_merge_hours
    FROM github_pull_requests
    WHERE merged_at IS NOT NULL
      AND created_at IS NOT NULL
      AND merged_at >= created_at
    GROUP BY full_name
),
base AS (
    SELECT
        r.full_name,
        r.primary_language,
        r.stars,
        r.forks,
        r.pushed_at,
        GREATEST(EXTRACT(EPOCH FROM (NOW() - r.pushed_at)) / 86400.0, 0) AS days_since_push,
        ps.pr_sample,
        ps.median_merge_hours
    FROM github_repos r
    LEFT JOIN pr_stats ps ON ps.full_name = r.full_name
    WHERE r.is_fork = false
      AND r.stars >= 50
      AND r.pushed_at IS NOT NULL
),
scored AS (
    SELECT
        full_name,
        primary_language,
        stars,
        forks,
        pushed_at,
        COALESCE(pr_sample, 0) AS pr_sample,
        ROUND(median_merge_hours::numeric, 1) AS median_merge_hours,
        LEAST(EXP(-days_since_push / 90.0), 1.0) AS recency,
        LEAST(LN(1 + stars) / LN(1 + 100000), 1.0) AS reach,
        CASE
            WHEN pr_sample >= 5 AND median_merge_hours IS NOT NULL
            THEN 1.0 / (1.0 + median_merge_hours / 72.0)
            ELSE NULL
        END AS merge
    FROM base
)
SELECT
    full_name,
    primary_language AS language,
    stars,
    pr_sample,
    median_merge_hours,
    pushed_at::date AS last_push,
    ROUND((100 * CASE
        WHEN merge IS NOT NULL
            THEN 0.45 * recency + 0.30 * reach + 0.25 * merge
        ELSE 0.60 * recency + 0.40 * reach
    END)::numeric, 2) AS v1_score
FROM scored
ORDER BY v1_score DESC, stars DESC
LIMIT 100;
