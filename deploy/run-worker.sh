#!/bin/bash
#
# run-worker.sh — hardened launcher for refresh-worker.ts
#
# What this does:
#   - Loops forever, re-running the worker if it exits (crash-safe).
#   - Sleeps 10s between restarts so a config error doesn't crash-loop the box.
#   - Captures stdout+stderr to app.log with start/exit markers.
#
# How to deploy on the droplet (DigitalOcean / Hetzner / etc.):
#
#   1) Clone & install:
#        git clone <this-repo> /root/github-data-pipeline
#        cd /root/github-data-pipeline
#        npm install
#
#   2) Create /root/github-data-pipeline/.env.local with:
#        NODE_ENV=production
#        DATABASE_URL=postgres://...
#        GITHUB_TOKENS=pat1,pat2,pat3,pat4,pat5
#
#   3) First run (watch logs live in tmux):
#        tmux new -s worker
#        bash deploy/run-worker.sh
#        # Ctrl+B then D to detach. `tmux attach -t worker` to come back.
#
#   4) Survive reboots — add to root's crontab (`crontab -e`):
#        @reboot tmux new-session -d -s worker 'bash /root/github-data-pipeline/deploy/run-worker.sh'
#
#   5) Rotate logs — copy the bundled config:
#        sudo cp deploy/refresh-worker.logrotate /etc/logrotate.d/refresh-worker
#
# Stop the worker:
#   tmux attach -t worker     # then Ctrl+C twice (worker, then this loop)
#   tmux kill-session -t worker
#

set -u

# Resolve the project root from this script's location so it works
# regardless of where the repo was cloned.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_DIR/app.log"
RESTART_SLEEP_SECONDS="${RESTART_SLEEP_SECONDS:-10}"

cd "$PROJECT_DIR" || exit 1

echo "[run-worker] launching from $PROJECT_DIR, logging to $LOG_FILE"
echo "[run-worker] restart sleep: ${RESTART_SLEEP_SECONDS}s — Ctrl+C twice to stop"

while true; do
  {
    echo ""
    echo "=== started at $(date -Iseconds) ==="
  } >> "$LOG_FILE"

  # tsx is preferred; the npm script wraps it consistently with the rest of the repo.
  npm run refresh-worker --silent >> "$LOG_FILE" 2>&1
  exit_code=$?

  echo "=== exited at $(date -Iseconds) with code ${exit_code} ===" >> "$LOG_FILE"

  # Honor Ctrl+C (SIGINT exits with 130) — break out instead of looping.
  if [ "$exit_code" -eq 130 ]; then
    echo "[run-worker] worker exited via SIGINT — stopping loop"
    break
  fi

  sleep "$RESTART_SLEEP_SECONDS"
done
