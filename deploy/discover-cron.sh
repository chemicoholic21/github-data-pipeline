#!/bin/bash
#
# discover-cron.sh — run ONE rotation chunk of repo discovery, then exit.
#
# Discovers NEW open-source repositories directly from GitHub's repository
# search (independent of scraped users), biased toward recently-active repos,
# and inserts brand-new ones into github_repos. The compute-repo-health worker
# then scores them into repo_health. Together they keep the "good repos to
# contribute to" list fresh instead of stuck on the same handful.
#
# Each run advances a persisted rotation cursor (.discover-cursor) so successive
# ticks cover the whole search matrix, then wrap around.
#
# flock ensures a run that overruns the interval can never overlap the next one.
#
# --- Schedule it -----------------------------------------------------------
#
# cron (`crontab -e`) — discover every 15 minutes:
#   */15 * * * * /root/github-data-pipeline/deploy/discover-cron.sh >> /root/github-data-pipeline/discover-cron.log 2>&1
#
# Pair it with the health scorer (staggered so they don't fight for tokens):
#   5-59/15 * * * * cd /root/github-data-pipeline && ONESHOT=1 LIMIT=50 npm run compute-repo-health --silent >> compute-health.log 2>&1
#
# Tunables (export before calling, or set in .env / .env.local):
#   DISCOVER_QUERIES_PER_RUN (default 6)
#   DISCOVER_PAGES_PER_QUERY (default 2)
#   DISCOVER_MIN_STARS       (default 100)
#   DISCOVER_RECENT_DAYS     (default 180)
#

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="${LOCK_FILE:-$PROJECT_DIR/.discover-cron.lock}"

cd "$PROJECT_DIR" || exit 1

# flock -n: if a previous run still holds the lock, exit now instead of piling up.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[discover-cron] $(date -Iseconds) previous run still active — skipping this tick"
  exit 0
fi

echo "[discover-cron] $(date -Iseconds) starting one rotation chunk"

ONESHOT=1 npm run discover-repos --silent
exit_code=$?

echo "[discover-cron] $(date -Iseconds) finished (exit ${exit_code})"
exit "$exit_code"
