#!/usr/bin/env bash
#
# copy-neon-to-supabase.sh
# ------------------------------------------------------------------
# Streams table DATA from a source Postgres (Neon) into a destination
# Postgres (Supabase) that ALREADY HAS THE SCHEMA created (17 tables +
# 3 materialized views).
#
# It streams each table directly (COPY TO STDOUT | COPY FROM STDIN) so
# nothing is written to local disk, and it never touches sequences on
# the source (works with a read-only role that lacks sequence access).
#
# The 3 materialized views are NOT copied -- they are REFRESHed from the
# base tables at the end. The 2 sequences are reset to MAX(id)+1.
#
# SAFE TO RE-RUN: it TRUNCATEs the destination tables first, so a second
# run produces the same result (no duplicate rows).
#
# Usage:
#   export SRC='postgresql://USER:PASS@NEON_HOST/neondb?sslmode=require'
#   export DST='postgresql://...SUPABASE...?sslmode=require'
#   ./migration/copy-neon-to-supabase.sh
#
# If your network is IPv4-only, use the Supabase SESSION POOLER string
# for DST (host aws-0-<region>.pooler.supabase.com:5432, user
# postgres.<project-ref>), because the direct db.<ref>.supabase.co host
# is IPv6-only.
# ------------------------------------------------------------------
set -euo pipefail

: "${SRC:?Set SRC to the Neon (source) connection string}"
: "${DST:?Set DST to the Supabase (destination) connection string}"

# All 17 base tables (materialized views are handled separately).
TABLES=(
  github_users            # parent (referenced by FKs) -- load first
  skills                  # parent
  leaderboard_old         # parent
  conversations           # child of github_users
  messages                # child of conversations/github_users
  user_skill_scores       # child of skills/leaderboard_old
  analyses
  api_cache
  api_cache_old
  github_pull_requests
  github_repos
  leaderboard
  repo_health
  token_rate_limit
  user_repo_scores
  user_scores
  users_old
)

MVIEWS=( user_repo_topics repo_topic_counts skill_topic_search )

log() { echo "[$(date +%H:%M:%S)] $*"; }

log "Sanity check: can reach both databases"
psql "$SRC" -tAc "select 'source ok'" >/dev/null
psql "$DST" -tAc "select 'dest ok'"   >/dev/null

log "Removing per-connection query timeouts on the destination (for big tables)"
psql "$DST" -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE postgres SET statement_timeout = 0;" \
  -c "ALTER ROLE postgres SET idle_in_transaction_session_timeout = 0;"

log "Emptying destination tables first (idempotent re-runs, one statement so FKs are fine)"
JOINED=$(printf 'public.%s, ' "${TABLES[@]}"); JOINED=${JOINED%, }
psql "$DST" -v ON_ERROR_STOP=1 -c "TRUNCATE ${JOINED} CASCADE;"

log "Streaming ${#TABLES[@]} tables Neon -> Supabase"
FAIL=0
for t in "${TABLES[@]}"; do
  log "  copying $t ..."
  # Direct stream: no local disk used. pipefail makes a source error fail the pipe.
  psql "$SRC" -c "COPY public.$t TO STDOUT" \
    | psql "$DST" -v ON_ERROR_STOP=1 -c "COPY public.$t FROM STDIN"

  s=$(psql "$SRC" -tAc "SELECT count(*) FROM public.$t")
  d=$(psql "$DST" -tAc "SELECT count(*) FROM public.$t")
  if [ "$s" = "$d" ]; then
    log "    OK  $t  (rows: $d)"
  else
    log "    !! MISMATCH $t  source=$s  dest=$d"
    FAIL=1
  fi
done

log "Refreshing materialized views"
for mv in "${MVIEWS[@]}"; do
  log "  REFRESH $mv"
  psql "$DST" -v ON_ERROR_STOP=1 -c "REFRESH MATERIALIZED VIEW public.$mv;"
done

log "Resetting sequences to MAX(id)+1"
psql "$DST" -v ON_ERROR_STOP=1 \
  -c "SELECT setval(pg_get_serial_sequence('public.api_cache','id'),        COALESCE((SELECT MAX(id) FROM public.api_cache),1),        true);" \
  -c "SELECT setval(pg_get_serial_sequence('public.user_repo_scores','id'), COALESCE((SELECT MAX(id) FROM public.user_repo_scores),1), true);"

echo
if [ "$FAIL" -eq 0 ]; then
  log "DONE ✅  All tables copied and row counts match."
else
  log "DONE with MISMATCHES ❌  Re-run the script or inspect the tables above."
  exit 1
fi
