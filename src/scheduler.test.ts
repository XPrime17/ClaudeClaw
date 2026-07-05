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
  completion_check: string | null;
  nudge_escalated_day: string | null;
  created_at: number;
}

const dbMocks = vi.hoisted(() => ({
  claimTask: vi.fn(),
  getActiveTasks: vi.fn(),
  getDueTasks: vi.fn(),
  setTaskNextRun: vi.fn(),
  updateTaskAfterRun: vi.fn(),
  markTaskNudgeEscalated: vi.fn(),
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

// The scheduler wires in the log-only completion sweep AND the response-gated
// nudge helpers; mock the module wholesale so these tests stay hermetic (the
// sweep + landing logic is tested in completion.test.ts). Every symbol the
// scheduler imports from completion.js MUST be present here or the wholesale
// mock resolves those names to undefined and the module throws on call.
const completionMocks = vi.hoisted(() => ({
  sweepCompletions: vi.fn(),
  checkLandedToday: vi.fn(),
  consecutiveMissedDays: vi.fn(),
  // recentDays is only used for log context; a lightweight faithful stub keeps
  // the scheduler's logging calls working without importing the real tz math.
  recentDays: vi.fn((n: number) => Array.from({ length: n }, (_v, i) => `day-${i}`)),
}));

vi.mock('./db.js', () => dbMocks);
vi.mock('./agent.js', () => agentMocks);
vi.mock('./logger.js', () => loggerMocks);
vi.mock('./completion.js', () => completionMocks);

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
    completion_check: null,
    nudge_escalated_day: null,
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
  dbMocks.markTaskNudgeEscalated.mockReturnValue(true);
  // Default: no data landed, no missed streak — check-tasks fall through to a
  // normal agent run unless a test overrides these.
  completionMocks.checkLandedToday.mockReturnValue(false);
  completionMocks.consecutiveMissedDays.mockReturnValue(0);
  agentMocks.runAgent.mockResolvedValue({ text: 'ok' });
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

  test('non-check task passes straight through to the agent, untouched by nudge logic', async () => {
    const send = vi.fn(async (_chatId: string, _text: string): Promise<void> => {});
    initScheduler(send);
    dbMocks.getDueTasks.mockReturnValue([scheduledTask({ completion_check: null })]);

    await runDueTasks();

    // The nudge subsystem must not be consulted at all for a plain task.
    expect(completionMocks.checkLandedToday).not.toHaveBeenCalled();
    expect(completionMocks.consecutiveMissedDays).not.toHaveBeenCalled();
    expect(dbMocks.markTaskNudgeEscalated).not.toHaveBeenCalled();
    // Normal execution still happens.
    expect(agentMocks.runAgent).toHaveBeenCalledTimes(1);
  });
});

describe('runDueTasks — response-gated nudging', () => {
  const checkTask = (overrides: Partial<TestScheduledTask> = {}): TestScheduledTask =>
    scheduledTask({
      id: 'weight-task-0001abcd',
      completion_check: JSON.stringify({ kind: 'weight' }),
      ...overrides,
    });

  test('skip-if-landed: no agent run, no message sent, but slot already claimed', async () => {
    const send = vi.fn(async (_chatId: string, _text: string): Promise<void> => {});
    initScheduler(send);
    completionMocks.checkLandedToday.mockReturnValue(true);
    dbMocks.getDueTasks.mockReturnValue([checkTask()]);

    await runDueTasks();

    expect(dbMocks.claimTask).toHaveBeenCalledTimes(1); // slot consumed
    expect(completionMocks.checkLandedToday).toHaveBeenCalledTimes(1);
    expect(agentMocks.runAgent).not.toHaveBeenCalled();
    // No message of ANY kind — not the "Running…" line, not a result.
    expect(send).not.toHaveBeenCalled();
    // Landed path never touches the breaker.
    expect(completionMocks.consecutiveMissedDays).not.toHaveBeenCalled();
    expect(dbMocks.markTaskNudgeEscalated).not.toHaveBeenCalled();
  });

  test('breaker does NOT trip at 2 missed days — the nudge fires normally', async () => {
    const send = vi.fn(async (_chatId: string, _text: string): Promise<void> => {});
    initScheduler(send);
    completionMocks.checkLandedToday.mockReturnValue(false);
    completionMocks.consecutiveMissedDays.mockReturnValue(2);
    dbMocks.getDueTasks.mockReturnValue([checkTask()]);

    await runDueTasks();

    expect(dbMocks.markTaskNudgeEscalated).not.toHaveBeenCalled();
    expect(agentMocks.runAgent).toHaveBeenCalledTimes(1);
  });

  test('breaker trips at exactly 3 missed days — suppressed with exactly one escalation message', async () => {
    const send = vi.fn(async (_chatId: string, _text: string): Promise<void> => {});
    initScheduler(send);
    completionMocks.checkLandedToday.mockReturnValue(false);
    completionMocks.consecutiveMissedDays.mockReturnValue(3);
    dbMocks.markTaskNudgeEscalated.mockReturnValue(true); // first escalation for this streak
    dbMocks.getDueTasks.mockReturnValue([checkTask()]);

    await runDueTasks();

    expect(agentMocks.runAgent).not.toHaveBeenCalled();
    expect(dbMocks.markTaskNudgeEscalated).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [, text] = send.mock.calls[0];
    expect(text).toContain('3 days of weight nudges');
    expect(text).toContain('resume-nudge weight-t'); // id.slice(0, 8) === 'weight-t'
  });

  test('escalate-once: a second tick in the same streak suppresses silently (no second message)', async () => {
    const send = vi.fn(async (_chatId: string, _text: string): Promise<void> => {});
    initScheduler(send);
    completionMocks.checkLandedToday.mockReturnValue(false);
    completionMocks.consecutiveMissedDays.mockReturnValue(4);
    // The flag is already set from a prior tick — the scheduler short-circuits
    // before ever consulting the breaker or the sender.
    dbMocks.getDueTasks.mockReturnValue([
      checkTask({ nudge_escalated_day: '2026-07-04' }),
    ]);

    await runDueTasks();

    expect(agentMocks.runAgent).not.toHaveBeenCalled();
    expect(dbMocks.markTaskNudgeEscalated).not.toHaveBeenCalled();
    expect(completionMocks.consecutiveMissedDays).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test('reset on landing: a landed check clears suppression and lets nudges resume', async () => {
    const send = vi.fn(async (_chatId: string, _text: string): Promise<void> => {});
    initScheduler(send);
    // Even though the flag is set, checkLandedToday returning true (which itself
    // clears the flag in completion.ts) short-circuits to the skip path — no
    // agent, no message. The clearing is asserted in completion.test.ts.
    completionMocks.checkLandedToday.mockReturnValue(true);
    dbMocks.getDueTasks.mockReturnValue([
      checkTask({ nudge_escalated_day: '2026-07-04' }),
    ]);

    await runDueTasks();

    expect(agentMocks.runAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(completionMocks.checkLandedToday).toHaveBeenCalledTimes(1);
  });
});
