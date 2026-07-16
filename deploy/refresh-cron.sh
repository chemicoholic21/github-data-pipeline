#!/bin/bash
#
# refresh-cron.sh — run ONE batch of the stale-profile refresh, then exit.
#
# Designed to be fired on a schedule (every 10 minutes). Each run:
#   - selects users whose github_users.scraped_at is older than
#     REFRESH_AFTER_DAYS (default 30, matching the api_cache 30-day TTL),
#   - re-fetches them from the GitHub GraphQL API,
#   - updates every table (github_users/repos/pull_requests, *_scores,
#     leaderboard, user_skill_scores) and UPSERTS api_cache by cache_key
#     (updates the existing row in place — never inserts a duplicate).
#
# It uses flock so a run that overruns the interval can never overlap the next
# one; the later fire simply exits immediately.
#
# --- Schedule it (every 10 minutes) --------------------------------------------
#
# Option A — cron (`crontab -e`):
#   */10 * * * * /root/github-data-pipeline/deploy/refresh-cron.sh >> /root/github-data-pipeline/refresh-cron.log 2>&1
#
# Option B — systemd timer (survives reboots, better logging). Create:
#
#   /etc/systemd/system/refresh.service
#     [Unit]
#     Description=GitHub data refresh (one batch)
#     [Service]
#     Type=oneshot
#     WorkingDirectory=/root/github-data-pipeline
#     ExecStart=/root/github-data-pipeline/deploy/refresh-cron.sh
#
#   /etc/systemd/system/refresh.timer
#     [Unit]
#     Description=Run GitHub data refresh every 10 minutes
#     [Timer]
#     OnBootSec=2min
#     OnUnitActiveSec=10min
#     AccuracySec=30s
#     [Install]
#     WantedBy=timers.target
#
#   Then: sudo systemctl daemon-reload && sudo systemctl enable --now refresh.timer
#   (systemd won't start a second run while one is active, so flock is belt-and-suspenders.)
#
# Tunables (export before calling, or set in .env / .env.local):
#   REFRESH_BATCH (default 50)   how many stale users to refresh per run
#   REFRESH_AFTER_DAYS (default 30)
#

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="${LOCK_FILE:-$PROJECT_DIR/.refresh-cron.lock}"
REFRESH_BATCH="${REFRESH_BATCH:-50}"

cd "$PROJECT_DIR" || exit 1

# flock -n: if a previous run still holds the lock, exit now instead of piling up.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[refresh-cron] $(date -Iseconds) previous run still active — skipping this tick"
  exit 0
fi

echo "[refresh-cron] $(date -Iseconds) starting one-shot batch of ${REFRESH_BATCH}"

# One batch, then exit. `npm run refresh-worker` wraps tsx consistently with the repo.
ONESHOT=1 LIMIT="$REFRESH_BATCH" npm run refresh-worker --silent
exit_code=$?

echo "[refresh-cron] $(date -Iseconds) finished (exit ${exit_code})"
exit "$exit_code"
