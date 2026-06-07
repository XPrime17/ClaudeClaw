import cronParser from 'cron-parser';
const { parseExpression } = cronParser;
import { getDueTasks, updateTaskAfterRun } from './db.js';
import { runAgent } from './agent.js';
import { logger } from './logger.js';

type Sender = (chatId: string, text: string) => Promise<void>;

let sender: Sender;
let intervalId: ReturnType<typeof setInterval> | null = null;

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

/**
 * Start the scheduler loop. Call once at boot after the bot is ready.
 * The `send` callback is used to push results back to the originating chat.
 */
export function initScheduler(send: Sender): void {
  sender = send;
  intervalId = setInterval(runDueTasks, 60_000);
  logger.info('Scheduler initialized (polling every 60s)');
}

/**
 * Check for tasks whose next_run has passed and execute them sequentially.
 * Called automatically every 60 s by the scheduler interval.
 */
export async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks();
  for (const task of tasks) {
    try {
      logger.info(
        { taskId: task.id, prompt: task.prompt.slice(0, 50) },
        'Running scheduled task',
      );

      await sender(
        task.chat_id,
        `Running scheduled task: ${task.prompt.slice(0, 100)}...`,
      );

      const agentResult = await runAgent(task.prompt);
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
 * Uses milliseconds to match Date.now() comparisons in getDueTasks().
 */
export function computeNextRun(cronExpression: string): number {
  const interval = parseExpression(cronExpression);
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
}
