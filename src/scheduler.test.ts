import { afterEach, describe, expect, test, vi } from 'vitest';

interface TestScheduledTask {
  id: string;
  chat_id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused';
  created_at: number;
}

const dbMocks = vi.hoisted(() => ({
  claimTask: vi.fn(),
  getActiveTasks: vi.fn(),
  getDueTasks: vi.fn(),
  setTaskNextRun: vi.fn(),
  updateTaskAfterRun: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  formatAgentError: vi.fn((error: unknown) => String(error)),
  runAgent: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('./db.js', () => dbMocks);
vi.mock('./agent.js', () => agentMocks);
vi.mock('./logger.js', () => loggerMocks);

import { computeNextRun, initScheduler, runDueTasks, stopScheduler } from './scheduler.js';

function scheduledTask(overrides: Partial<TestScheduledTask> = {}): TestScheduledTask {
  return {
    id: 'task-1',
    chat_id: 'chat-1',
    prompt: 'test prompt',
    schedule: '0 9 * * *',
    next_run: Date.now() - 60_000,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: Date.now() - 120_000,
    ...overrides,
  };
}

afterEach(() => {
  stopScheduler();
  vi.clearAllMocks();
  dbMocks.claimTask.mockReturnValue(true);
  dbMocks.getActiveTasks.mockReturnValue([]);
  dbMocks.getDueTasks.mockReturnValue([]);
});

describe('computeNextRun', () => {
  test('evaluates cron in America/Toronto by default', () => {
    const nextRun = computeNextRun('0 9 * * *');
    const hour = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      hour: '2-digit',
      hour12: false,
    }).format(new Date(nextRun));

    expect(hour).toBe('09');
  });
});

describe('initScheduler', () => {
  test('throws a diagnostic error on second start', () => {
    const send = vi.fn(async (_chatId: string, _text: string): Promise<void> => {});

    initScheduler(send);

    expect(() => initScheduler(send)).toThrow(/double-scheduler incident.*~523 duplicate tasks/);
  });

  test('resyncs active tasks and skips invalid cron expressions', () => {
    const send = vi.fn(async (_chatId: string, _text: string): Promise<void> => {});
    dbMocks.getActiveTasks.mockReturnValue([
      scheduledTask({ id: 'valid-task', schedule: '0 9 * * *' }),
      scheduledTask({ id: 'invalid-task', schedule: 'not cron' }),
      scheduledTask({ id: 'later-valid-task', schedule: '0 10 * * *' }),
    ]);

    initScheduler(send);

    expect(dbMocks.setTaskNextRun).toHaveBeenCalledTimes(2);
    expect(dbMocks.setTaskNextRun).toHaveBeenCalledWith('valid-task', expect.any(Number));
    expect(dbMocks.setTaskNextRun).toHaveBeenCalledWith('later-valid-task', expect.any(Number));
    expect(loggerMocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'invalid-task', schedule: 'not cron' }),
      'Failed to resync scheduled task next_run',
    );
  });
});

describe('runDueTasks', () => {
  test('skips a task when cron computation fails before claim', async () => {
    dbMocks.getDueTasks.mockReturnValue([
      scheduledTask({ schedule: 'not cron' }),
    ]);

    await runDueTasks();

    expect(dbMocks.claimTask).not.toHaveBeenCalled();
    expect(agentMocks.runAgent).not.toHaveBeenCalled();
  });

  test('skips execution when another executor already claimed the task', async () => {
    dbMocks.claimTask.mockReturnValue(false);
    dbMocks.getDueTasks.mockReturnValue([
      scheduledTask(),
    ]);

    await runDueTasks();

    expect(dbMocks.claimTask).toHaveBeenCalledTimes(1);
    expect(agentMocks.runAgent).not.toHaveBeenCalled();
  });
});
