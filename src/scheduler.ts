import cronParser from 'cron-parser';
const { parseExpression } = cronParser;
import { TIMEZONE } from './config.js';
import {
  claimTask,
  getActiveTasks,
  getDueTasks,
  markTaskNudgeEscalated,
  setTaskNextRun,
  updateTaskAfterRun,
} from './db.js';
import { runAgent, formatAgentError } from './agent.js';
import {
  checkLandedToday,
  consecutiveMissedDays,
  recentDays,
  sweepCompletions,
} from './completion.js';
import { logger } from './logger.js';

type Sender = (chatId: string, text: string) => Promise<void>;

let sender: Sender;
let intervalId: ReturnType<typeof setInterval> | null = null;
let schedulerStarted = false;

/** Base backoff delay in ms (60 seconds). */
const BACKOFF_BASE_MS = 60_000;

/** Maximum backoff delay in ms (30 minutes). */
const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Max consecutive failed retries before giving up on the current occurrence and
 * resuming the task's normal cron schedule. Without this, a persistently failing
 * task (e.g. expired login) hammers every 30min and its backoff time clobbers the
 * cron `next_run`, causing the task to fire at the wrong time of day once it
 * recovers. After this many failures we reschedule to the next real cron slot.
 */
const MAX_RETRIES = 5;

/** Per-task consecutive failure counter (resets on success or process restart). */
const failureCounts = new Map<string, number>();

/** Log-only completion sweep runs at most hourly; never affects scheduling. */
const SWEEP_INTERVAL_MS = 60 * 60_000;
let lastSweepMs = 0;
const NUDGE_BREAKER_THRESHOLD = 3;

/**
 * Start the scheduler loop. Call once at boot after the bot is ready.
 * The `send` callback is used to push results back to the originating chat.
 */
export function initScheduler(send: Sender): void {
  if (schedulerStarted) {
    throw new Error('Scheduler already started: refusing duplicate initScheduler call after the double-scheduler incident that fired ~523 duplicate tasks');
  }

  sender = send;
  schedulerStarted = true;
  try {
    resyncActiveTaskRuns();
    runCompletionSweep(); // one log-only sweep at boot after resync
    intervalId = setInterval(runDueTasks, 60_000);
    logger.info('Scheduler initialized (polling every 60s)');
  } catch (err) {
    schedulerStarted = false;
    throw err;
  }
}

/**
 * Check for tasks whose next_run has passed and execute them sequentially.
 * Called automatically every 60 s by the scheduler interval.
 */
export async function runDueTasks(): Promise<void> {
  runCompletionSweep();
  const tasks = getDueTasks();
  for (const task of tasks) {
    const now = Date.now();
    let claimedNextRun: number;
    try {
      claimedNextRun = computeNextRun(task.schedule);
    } catch (err) {
      logger.error(
        { taskId: task.id, schedule: task.schedule, err: errorMessage(err) },
        'Scheduled task has invalid cron expression; skipping claim',
      );
      continue;
    }

    if (!claimTask(task.id, claimedNextRun, now)) {
      logger.info(
        { taskId: task.id, nextRun: new Date(claimedNextRun).toISOString() },
        'Scheduled task already claimed by another executor; skipping',
      );
      continue;
    }

    try {
      if (task.completion_check) {
        if (checkLandedToday(task, now)) {
          logger.info(
            { taskId: task.id, day: recentDays(1, TIMEZONE, now)[0] },
            'Scheduled task skipped because data already landed today',
          );
          continue;
        }

        if (task.nudge_escalated_day !== null) {
          logger.info(
            { taskId: task.id, escalatedDay: task.nudge_escalated_day },
            'Scheduled task nudge suppressed because the circuit breaker is already active',
          );
          continue;
        }

        const missedDays = consecutiveMissedDays(task.id, now);
        if (missedDays >= NUDGE_BREAKER_THRESHOLD) {
          const today = recentDays(1, TIMEZONE, now)[0];
          const escalated = markTaskNudgeEscalated(task.id, today);
          if (escalated) {
            const kind = formatCompletionKind(task.completion_check);
            await sender(
              task.chat_id,
              `⚠️ ${missedDays} days of ${kind} nudges with no data landed. Pausing this nudge until data lands. (Log data or /schedule resume-nudge ${task.id.slice(0, 8)} to resume.)`,
            );
          }
          logger.info(
            { taskId: task.id, consecutiveMissed: missedDays, escalated },
            'Scheduled task nudge suppressed by circuit breaker',
          );
          continue;
        }
      }

      logger.info(
        { taskId: task.id, prompt: task.prompt.slice(0, 50) },
        'Running scheduled task',
      );

      await sender(
        task.chat_id,
        `Running scheduled task: ${task.prompt.slice(0, 100)}...`,
      );

      const agentResult = await runAgent(task.prompt);
      // An SDK non-success result (max turns, execution error, …) is a task
      // failure — route it through the catch so backoff + the diagnostic
      // notification apply, same as a thrown error.
      if (agentResult.error) {
        throw new Error(formatAgentError(agentResult.error));
      }
      const result = agentResult.text || '(no output)';
      const nextRun = computeNextRun(task.schedule);
      updateTaskAfterRun(task.id, nextRun, result);

      // Success — reset failure counter
      failureCounts.delete(task.id);

      await sender(task.chat_id, `Task result:\n${result}`);
    } catch (err: any) {
      // Increment consecutive failure count
      const failures = (failureCounts.get(task.id) ?? 0) + 1;
      failureCounts.set(task.id, failures);

      // The next legitimate cron occurrence — the retry must never push past it,
      // otherwise the task fires at the wrong time of day.
      let nextCron: number;
      try {
        nextCron = computeNextRun(task.schedule);
      } catch {
        nextCron = Date.now() + MAX_BACKOFF_MS;
      }

      if (failures >= MAX_RETRIES) {
        // Stop hammering — give up on this occurrence and resume the schedule.
        updateTaskAfterRun(task.id, nextCron, `FAILED (gave up after ${failures}): ${err.message}`);
        failureCounts.delete(task.id);
        logger.error(
          { taskId: task.id, err: err.message, failures, resumingAt: new Date(nextCron).toISOString() },
          'Scheduled task failed too many times — resuming normal schedule',
        );
        await sender(
          task.chat_id,
          `Task "${task.prompt.slice(0, 50)}" failed ${failures}x. Giving up for now, will run at its next scheduled time.\nError: ${err.message}`,
        );
      } else {
        // Exponential backoff: 60s, 120s, 240s, ... capped at 30min — but never
        // later than the next scheduled occurrence.
        const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
        const nextRun = Math.min(Date.now() + delayMs, nextCron);
        updateTaskAfterRun(task.id, nextRun, `FAILED: ${err.message}`);

        const delayMin = Math.max(1, Math.round((nextRun - Date.now()) / 60_000));
        logger.error(
          { taskId: task.id, err: err.message, failures, nextRetryIn: `${delayMin}min` },
          'Scheduled task failed — backing off',
        );
        // Only notify on the first failure to avoid spamming the chat on every retry.
        if (failures === 1) {
          await sender(
            task.chat_id,
            `Task "${task.prompt.slice(0, 50)}" failed. Retrying (up to ${MAX_RETRIES}x).\nError: ${err.message}`,
          );
        }
      }
    }
  }
}

/**
 * Given a cron expression, return the next fire time as a Unix timestamp (ms).
 * Cron expressions are evaluated in TIMEZONE. Uses milliseconds to match
 * Date.now() comparisons in getDueTasks().
 */
export function computeNextRun(cronExpression: string): number {
  const interval = parseExpression(cronExpression, { tz: TIMEZONE });
  return interval.next().getTime();
}

/**
 * Stop the scheduler polling loop.
 */
export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  schedulerStarted = false;
}

function resyncActiveTaskRuns(): void {
  const tasks = getActiveTasks();
  for (const task of tasks) {
    try {
      const nextRun = computeNextRun(task.schedule);
      setTaskNextRun(task.id, nextRun);
      logger.info(
        { taskId: task.id, schedule: task.schedule, nextRun: new Date(nextRun).toISOString() },
        'Scheduled task next_run resynced',
      );
    } catch (err) {
      logger.error(
        { taskId: task.id, schedule: task.schedule, err: errorMessage(err) },
        'Failed to resync scheduled task next_run',
      );
    }
  }
}

/**
 * Run the log-only data-landed sweep at most once per hour. Purely
 * observational — it never mutates next_run, backoff, or failure counters.
 */
function runCompletionSweep(): void {
  const now = Date.now();
  if (now - lastSweepMs < SWEEP_INTERVAL_MS) return;
  lastSweepMs = now;
  sweepCompletions(now);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatCompletionKind(completionCheck: string): string {
  try {
    const parsed = JSON.parse(completionCheck) as {
      kind?: 'weight' | 'meal';
      mealType?: string;
    };
    if (parsed.kind === 'weight') {
      return 'weight';
    }
    if (parsed.kind === 'meal') {
      return parsed.mealType ? `meal:${parsed.mealType}` : 'meal';
    }
  } catch {
    // Invalid JSON falls back to a generic label so the nudge can still be suppressed safely.
  }

  return 'tracked';
}
