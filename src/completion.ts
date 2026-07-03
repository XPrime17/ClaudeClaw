import { readFileSync } from 'fs';
import { join } from 'path';
import { TIMEZONE, WORKSPACE_DIR } from './config.js';
import {
  countLandedDays,
  getTaskLandedDays,
  getTasksWithChecks,
  upsertCompletionLog,
} from './db.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Completion check contract (stored as JSON in scheduled_tasks.completion_check)
//
// LOG-ONLY subsystem: records whether the user's data actually landed for a
// nudge (weight entry / meal log in the workspace JSON) per task per
// Toronto-day. It must NEVER influence scheduling, retries, or backoff.
// ---------------------------------------------------------------------------

export type MealType = 'breakfast' | 'lunch' | 'dinner';

export interface CompletionCheck {
  kind: 'weight' | 'meal';
  mealType?: MealType;
}

interface DataEntry {
  date?: string;
  timestamp?: string;
  mealType?: string;
  [key: string]: unknown;
}

/** Resolve the workspace JSON file backing a given completion check. */
export function resolveCheckFile(check: CompletionCheck): string {
  const file = check.kind === 'weight' ? 'weight-data.json' : 'meal-log.json';
  return join(WORKSPACE_DIR, 'meal-data', file);
}

/** Day string (YYYY-MM-DD) for a Date in a timezone, via Intl — never toISOString. */
function dayStringInTz(date: Date, timezone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** The last N timezone-local day strings ending today (index 0 = today). */
export function recentDays(n: number, timezone: string, now = Date.now()): string[] {
  const days: string[] = [];
  for (let i = 0; i < n; i++) {
    days.push(dayStringInTz(new Date(now - i * 86_400_000), timezone));
  }
  return days;
}

/**
 * True when an entry's landing counts toward timezone-local day `dayStr`.
 *
 * The `date` field in the workspace files is UTC-derived
 * (toISOString().split('T')[0]) so an evening Toronto entry carries the NEXT
 * UTC day. The authoritative predicate is therefore: the entry's parsed
 * `timestamp` falls within the local calendar day. If the timestamp is
 * missing/unparseable we fall back to entry.date. For meal checks with a
 * mealType, entry.mealType must also match.
 */
export function entryLandedOnDay(
  entry: DataEntry,
  dayStr: string,
  timezone: string,
  mealType?: MealType,
): boolean {
  if (mealType && entry.mealType !== mealType) return false;

  const ms = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isNaN(ms)) {
    return dayStringInTz(new Date(ms), timezone) === dayStr;
  }
  // Fallback: no parseable timestamp — trust the (UTC-derived) date field.
  return entry.date === dayStr;
}

/** Read + parse a workspace data file. Returns [] on any error (dev machines). */
function readEntries(path: string): DataEntry[] {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as { entries?: DataEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (err) {
    logger.error(
      { path, err: err instanceof Error ? err.message : String(err) },
      'Completion sweep: failed to read data file (treating as no data)',
    );
    return [];
  }
}

function parseCheck(json: string | null): CompletionCheck | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as CompletionCheck;
    if (parsed.kind !== 'weight' && parsed.kind !== 'meal') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Evaluate data landing for every checked task over the last 3 local days and
 * upsert results. LOG-ONLY — this must never influence scheduling. Every path
 * is wrapped so an exception is logged and swallowed, never propagating into
 * the scheduler loop.
 */
export function sweepCompletions(now = Date.now()): void {
  try {
    const tasks = getTasksWithChecks();
    if (tasks.length === 0) return;

    const days = recentDays(3, TIMEZONE, now); // today, yesterday, day-before

    for (const task of tasks) {
      try {
        const check = parseCheck(task.completion_check);
        if (!check) continue;

        const entries = readEntries(resolveCheckFile(check));

        for (const day of days) {
          // A date-fallback match (no parseable timestamp) still counts as
          // landed — it just has no landed_at instant to record.
          let landed = false;
          let landedAt: number | null = null;
          for (const entry of entries) {
            if (entryLandedOnDay(entry, day, TIMEZONE, check.mealType)) {
              landed = true;
              const ms = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
              landedAt = Number.isNaN(ms) ? null : ms;
              break;
            }
          }
          upsertCompletionLog({
            taskId: task.id,
            day,
            dataLanded: landed,
            landedAt,
            checkedAt: now,
          });
        }
      } catch (err) {
        logger.error(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'Completion sweep: error evaluating task (swallowed)',
        );
      }
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Completion sweep: top-level error (swallowed)',
    );
  }
}

/** Distinct days with data landed across all tasks in the last 7 local days. */
export function getDataDaysThisWeek(now = Date.now()): number {
  return countLandedDays(recentDays(7, TIMEZONE, now));
}

/** Last-7-day landing map for one task (index 0 = today). */
export function getTaskLandingMap(
  taskId: string,
  now = Date.now(),
): Array<{ day: string; landed: boolean }> {
  const days = recentDays(7, TIMEZONE, now);
  const landed = getTaskLandedDays(taskId, days);
  return days.map((day) => ({ day, landed: landed.has(day) }));
}
