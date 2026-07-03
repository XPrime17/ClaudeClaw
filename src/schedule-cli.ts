#!/usr/bin/env node
/**
 * schedule-cli — manage scheduled tasks from the command line.
 *
 * Usage:
 *   bun run src/schedule-cli.ts create  <chat_id> <cron> <prompt...>
 *   bun run src/schedule-cli.ts list    [chat_id]
 *   bun run src/schedule-cli.ts delete  <task_id>
 *   bun run src/schedule-cli.ts pause   <task_id>
 *   bun run src/schedule-cli.ts resume  <task_id>
 */

import { randomUUID } from 'crypto';
import cronParser from 'cron-parser';
const { parseExpression } = cronParser;
import {
  initDatabase,
  createTask,
  listTasks,
  deleteTask,
  pauseTask,
  resumeTask,
  setTaskCompletionCheck,
  getTasksWithChecks,
} from './db.js';
import {
  getDataDaysThisWeek,
  getTaskLandingMap,
  type MealType,
} from './completion.js';

// Initialize database before any operations
initDatabase();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(): never {
  console.log(`
schedule-cli — manage ClaudeClaw scheduled tasks

Commands:
  create <chat_id> <cron> <prompt...>   Create a new scheduled task
  list   [chat_id]                      List tasks (optionally filter by chat)
  delete <task_id>                      Delete a task by ID
  pause  <task_id>                      Pause a task
  resume <task_id>                      Resume a paused task
  set-check <task_id> weight|meal [mealType]  Track whether nudged data lands
  clear-check <task_id>                 Stop tracking data landing
  stats                                 Show data-days/week + landing maps

Examples:
  schedule-cli create 12345 "0 9 * * *" "Send me a daily standup summary"
  schedule-cli list
  schedule-cli pause abc-123
`);
  process.exit(1);
}

function validateCron(expr: string): void {
  try {
    parseExpression(expr);
  } catch {
    console.error(`Invalid cron expression: "${expr}"`);
    process.exit(1);
  }
}

function printTable(
  rows: Array<Record<string, any>>,
  columns: string[],
): void {
  if (rows.length === 0) {
    console.log('(no tasks)');
    return;
  }

  // Compute column widths
  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = col.length;
    for (const row of rows) {
      const val = String(row[col] ?? '');
      if (val.length > widths[col]) widths[col] = val.length;
    }
  }

  // Header
  const header = columns.map((c) => c.padEnd(widths[c])).join('  ');
  console.log(header);
  console.log(columns.map((c) => '-'.repeat(widths[c])).join('  '));

  // Rows
  for (const row of rows) {
    const line = columns
      .map((c) => String(row[c] ?? '').padEnd(widths[c]))
      .join('  ');
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

if (!command) usage();

switch (command) {
  case 'create': {
    if (args.length < 3) {
      console.error('Usage: schedule-cli create <chat_id> <cron> <prompt...>');
      process.exit(1);
    }
    const chatId = args[0];
    const cron = args[1];
    const prompt = args.slice(2).join(' ');

    validateCron(cron);

    const id = randomUUID();
    const nextRun = parseExpression(cron).next().getTime();

    createTask({
      id,
      chatId,
      schedule: cron,
      prompt,
      nextRun,
    });

    console.log(`Task created: ${id}`);
    console.log(`  Chat:     ${chatId}`);
    console.log(`  Schedule: ${cron}`);
    console.log(`  Prompt:   ${prompt}`);
    console.log(`  Next run: ${new Date(nextRun).toISOString()}`);
    break;
  }

  case 'list': {
    const chatFilter = args[0] || '';
    if (!chatFilter) {
      console.error('Usage: schedule-cli list <chat_id>');
      console.error('  (chat_id is required — db.ts filters by chat)');
      process.exit(1);
    }
    const tasks = listTasks(chatFilter);
    printTable(
      tasks.map((t: any) => ({
        id: t.id.slice(0, 8) + '...',
        chat_id: t.chat_id,
        status: t.status,
        schedule: t.schedule,
        prompt: t.prompt.length > 40 ? t.prompt.slice(0, 37) + '...' : t.prompt,
        next_run: t.next_run
          ? new Date(t.next_run).toLocaleString()
          : '-',
      })),
      ['id', 'chat_id', 'status', 'schedule', 'prompt', 'next_run'],
    );
    break;
  }

  case 'delete': {
    if (!args[0]) {
      console.error('Usage: schedule-cli delete <task_id>');
      process.exit(1);
    }
    deleteTask(args[0]);
    console.log(`Deleted task: ${args[0]}`);
    break;
  }

  case 'pause': {
    if (!args[0]) {
      console.error('Usage: schedule-cli pause <task_id>');
      process.exit(1);
    }
    pauseTask(args[0]);
    console.log(`Paused task: ${args[0]}`);
    break;
  }

  case 'resume': {
    if (!args[0]) {
      console.error('Usage: schedule-cli resume <task_id>');
      process.exit(1);
    }
    resumeTask(args[0]);
    console.log(`Resumed task: ${args[0]}`);
    break;
  }

  case 'set-check': {
    if (args.length < 2) {
      console.error('Usage: schedule-cli set-check <task_id> weight|meal [mealType]');
      process.exit(1);
    }
    const taskId = args[0];
    const kind = args[1];
    if (kind !== 'weight' && kind !== 'meal') {
      console.error(`Invalid kind: "${kind}" (expected "weight" or "meal")`);
      process.exit(1);
    }
    let mealType: MealType | undefined;
    if (kind === 'meal' && args[2]) {
      const valid: MealType[] = ['breakfast', 'lunch', 'dinner'];
      if (!valid.includes(args[2] as MealType)) {
        console.error(`Invalid mealType: "${args[2]}" (expected ${valid.join('|')})`);
        process.exit(1);
      }
      mealType = args[2] as MealType;
    }
    const check = mealType ? { kind, mealType } : { kind };
    const ok = setTaskCompletionCheck(taskId, JSON.stringify(check));
    if (!ok) {
      console.error(`No task found with id: ${taskId}`);
      process.exit(1);
    }
    console.log(`Completion check set on ${taskId}: ${JSON.stringify(check)}`);
    break;
  }

  case 'clear-check': {
    if (!args[0]) {
      console.error('Usage: schedule-cli clear-check <task_id>');
      process.exit(1);
    }
    const ok = setTaskCompletionCheck(args[0], null);
    if (!ok) {
      console.error(`No task found with id: ${args[0]}`);
      process.exit(1);
    }
    console.log(`Cleared completion check: ${args[0]}`);
    break;
  }

  case 'stats': {
    console.log(`Data-days this week: ${getDataDaysThisWeek()}/7\n`);
    const tasks = getTasksWithChecks();
    if (tasks.length === 0) {
      console.log('(no completion-tracked tasks)');
      break;
    }
    printTable(
      tasks.map((t) => {
        const check = JSON.parse(t.completion_check ?? '{}') as {
          kind: string;
          mealType?: string;
        };
        const map = getTaskLandingMap(t.id)
          .slice()
          .reverse() // oldest -> newest, left to right
          .map((d) => (d.landed ? '✓' : '·'))
          .join('');
        return {
          id: t.id.slice(0, 8),
          kind: check.mealType ? `${check.kind}:${check.mealType}` : check.kind,
          last7: map,
        };
      }),
      ['id', 'kind', 'last7'],
    );
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    usage();
}
