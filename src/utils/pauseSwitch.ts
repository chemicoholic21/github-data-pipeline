/**
 * pauseSwitch.ts
 *
 * A tiny cross-process pause flag backed by a sentinel file on disk. Lets a
 * one-shot / heavy job (e.g. the repo_health backfill) temporarily stop the
 * continuous refresh-worker so the two aren't fighting over the GitHub token
 * budget at the same time.
 *
 * Two ways to use it:
 *   1. Automatic — start the backfill with PAUSE_REFRESH_DURING_BACKFILL=1.
 *      compute-repo-health creates the flag on startup and removes it on exit.
 *   2. Manual — `touch .refresh-paused` to pause, `rm .refresh-paused` to resume
 *      (override the path with REFRESH_PAUSE_FILE).
 *
 * The refresh-worker polls isRefreshPaused() and idles while the flag exists.
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_PAUSE_FILE = '.refresh-paused';

/** Absolute path of the sentinel file (override via REFRESH_PAUSE_FILE). */
export function pauseFilePath(): string {
  const configured = process.env.REFRESH_PAUSE_FILE;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.resolve(process.cwd(), DEFAULT_PAUSE_FILE);
}

/** True when the refresh-worker should pause. Never throws. */
export function isRefreshPaused(): boolean {
  try {
    return fs.existsSync(pauseFilePath());
  } catch {
    return false;
  }
}

/** Human-readable contents of the flag (reason/pid/since), or null if absent. */
export function readPauseInfo(): string | null {
  try {
    return fs.readFileSync(pauseFilePath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Create the pause flag. Idempotent. Returns the path written.
 * `since` is injectable so callers in environments without a wall clock can
 * pass a timestamp; defaults to now.
 */
export function pauseRefresh(reason = 'manual', since: string = new Date().toISOString()): string {
  const p = pauseFilePath();
  try {
    fs.writeFileSync(p, `reason=${reason}\npid=${process.pid}\nsince=${since}\n`);
  } catch (e) {
    console.error(`[pauseSwitch] failed to write pause file ${p}:`, (e as Error).message);
  }
  return p;
}

/** Remove the pause flag if present. Idempotent. Never throws. */
export function resumeRefresh(): void {
  const p = pauseFilePath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.error(`[pauseSwitch] failed to remove pause file ${p}:`, (e as Error).message);
  }
}
