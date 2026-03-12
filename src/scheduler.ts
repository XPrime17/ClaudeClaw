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

      // Exponential backoff: 60s, 120s, 240s, ... capped at 30min
      const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
      const nextRetry = Date.now() + delayMs;
      updateTaskAfterRun(task.id, nextRetry, `FAILED: ${err.message}`);

      const delayMin = Math.round(delayMs / 60_000);
      logger.error(
        { taskId: task.id, err: err.message, failures, nextRetryIn: `${delayMin}min` },
        'Scheduled task failed — backing off',
      );
      await sender(
        task.chat_id,
        `Task "${task.prompt.slice(0, 50)}" failed (attempt ${failures}). Retrying in ${delayMin}min.\nError: ${err.message}`,
      );
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
