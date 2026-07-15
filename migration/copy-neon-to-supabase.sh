#!/usr/bin/env bash
#
# copy-neon-to-supabase.sh
# ------------------------------------------------------------------
# Streams table DATA from a source Postgres (Neon) into a destination
# Postgres (Supabase) that ALREADY HAS THE SCHEMA created (17 tables +
# 3 materialized views).
#
# Key properties:
#   * Direct streaming (COPY TO STDOUT | COPY FROM STDIN) -- no local disk,
#     and it never reads sequences on the source (works with a read-only
#     role that lacks sequence access).
#   * RESUMABLE: a table whose destination row count already equals the
#     source count is SKIPPED, so re-runs continue where you left off.
#   * statement_timeout is disabled IN THE SAME SESSION as each COPY, so
#     big tables (api_cache, github_repos, ...) are not cut off by the
#     pooler's default 2-minute cap. (Setting it via ALTER ROLE does NOT
#     work through the Supabase pooler -- it must be SET in-session.)
#   * Materialized views are REFRESHed in dependency order at the end.
#   * The 2 sequences are reset to MAX(id)+1.
#
# Usage:
#   export SRC='postgresql://USER:PASS@NEON_HOST/neondb?sslmode=require'
#   export DST='postgresql://...SUPABASE_SESSION_POOLER...?sslmode=require'
#   ./migration/copy-neon-to-supabase.sh
#
# Optional:
#   SKIP="api_cache api_cache_old"   # tables to skip entirely
#   FORCE=1                          # re-copy even if counts already match
#
# Tip: run it inside tmux on a cloud host so it survives disconnects:
#   tmux new -s migrate
#   ./migration/copy-neon-to-supabase.sh 2>&1 | tee /tmp/migration.log
# ------------------------------------------------------------------
set -uo pipefail

: "${SRC:?Set SRC to the Neon (source) connection string}"
: "${DST:?Set DST to the Supabase (destination) connection string}"
SKIP="${SKIP:-}"
FORCE="${FORCE:-0}"

# All 17 base tables, parents (FK targets) before children.
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

# Materialized views, in REFRESH dependency order:
#   repo_topic_counts  <- github_repos
#   user_repo_topics   <- user_repo_scores, github_repos
#   skill_topic_search <- skills, user_skill_scores, repo_topic_counts (matview!)
MVIEWS=( repo_topic_counts user_repo_topics skill_topic_search )

log() { echo "[$(date +%H:%M:%S)] $*"; }
count() { psql "$1" -tAc "SELECT count(*) FROM public.$2"; }
in_list() { case " $2 " in *" $1 "*) return 0;; *) return 1;; esac; }

log "Sanity check: can reach both databases"
psql "$SRC" -tAc "select 1" >/dev/null || { echo "cannot reach SRC"; exit 1; }
psql "$DST" -tAc "select 1" >/dev/null || { echo "cannot reach DST"; exit 1; }

log "Streaming up to ${#TABLES[@]} tables Neon -> Supabase (already-complete tables are skipped)"
FAIL=0
for t in "${TABLES[@]}"; do
  if in_list "$t" "$SKIP"; then
    log "  SKIP (requested)  $t"
    continue
  fi

  s=$(count "$SRC" "$t")
  d=$(count "$DST" "$t")
  if [ "$FORCE" != "1" ] && [ "$s" = "$d" ]; then
    log "  already done      $t  (rows: $d)"
    continue
  fi

  log "  copying $t ...  (source rows: $s, dest currently: $d)"
  # Destination session: disable timeouts, truncate this table, then load.
  # (Multiple -c commands share ONE session, so SET persists into the COPY.)
  if psql "$SRC" -c "COPY public.$t TO STDOUT" \
       | psql "$DST" -v ON_ERROR_STOP=1 \
           -c "SET statement_timeout = 0" \
           -c "SET idle_in_transaction_session_timeout = 0" \
           -c "TRUNCATE public.$t CASCADE" \
           -c "COPY public.$t FROM STDIN"
  then
    d=$(count "$DST" "$t")
    if [ "$s" = "$d" ]; then
      log "    OK  $t  (rows: $d)"
    else
      log "    !! MISMATCH $t  source=$s  dest=$d"
      FAIL=1
    fi
  else
    log "    !! COPY FAILED for $t (rerun the script to retry just this table)"
    FAIL=1
  fi
done

log "Refreshing materialized views (dependency order)"
for mv in "${MVIEWS[@]}"; do
  log "  REFRESH $mv"
  psql "$DST" -v ON_ERROR_STOP=1 \
    -c "SET statement_timeout = 0" \
    -c "REFRESH MATERIALIZED VIEW public.$mv" \
    || { log "    !! REFRESH failed for $mv"; FAIL=1; }
done

log "Resetting sequences to MAX(id)+1"
psql "$DST" -v ON_ERROR_STOP=1 \
  -c "SELECT setval(pg_get_serial_sequence('public.api_cache','id'),        COALESCE((SELECT MAX(id) FROM public.api_cache),1),        true)" \
  -c "SELECT setval(pg_get_serial_sequence('public.user_repo_scores','id'), COALESCE((SELECT MAX(id) FROM public.user_repo_scores),1), true)" \
  >/dev/null || { log "    !! sequence reset failed"; FAIL=1; }

echo
if [ "$FAIL" -eq 0 ]; then
  log "DONE ✅  All requested tables copied, matviews refreshed, sequences reset."
else
  log "DONE with problems ❌  Re-run the script (it resumes) or inspect the lines above."
  exit 1
fi
