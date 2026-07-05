import { afterEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';

const configMocks = vi.hoisted(() => ({
  TIMEZONE: 'America/Toronto',
  WORKSPACE_DIR: '/tmp/claudeclaw-test-workspace',
}));

const dbMocks = vi.hoisted(() => ({
  getTasksWithChecks: vi.fn(),
  upsertCompletionLog: vi.fn(),
  countLandedDays: vi.fn(),
  getTaskLandedDays: vi.fn(),
  clearTaskNudgeEscalation: vi.fn(),
  getTaskCompletionHistoryBefore: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock('./config.js', () => configMocks);
vi.mock('./db.js', () => dbMocks);
vi.mock('fs', () => fsMocks);
vi.mock('./logger.js', () => loggerMocks);

import {
  entryLandedOnDay,
  sweepCompletions,
  resolveCheckFile,
  checkLandedToday,
  consecutiveMissedDays,
} from './completion.js';

afterEach(() => {
  vi.clearAllMocks();
  dbMocks.getTasksWithChecks.mockReturnValue([]);
  dbMocks.countLandedDays.mockReturnValue(0);
  dbMocks.getTaskLandedDays.mockReturnValue(new Set<string>());
  dbMocks.getTaskCompletionHistoryBefore.mockReturnValue([]);
});

describe('entryLandedOnDay — timestamp Toronto-day predicate', () => {
  test('evening Toronto entry (next UTC day) lands on the Toronto day', () => {
    // 2026-07-02 23:30 America/Toronto (EDT, -04:00) == 2026-07-03T03:30Z
    const entry = { date: '2026-07-03', timestamp: '2026-07-03T03:30:00.000Z' };
    expect(entryLandedOnDay(entry, '2026-07-02', 'America/Toronto')).toBe(true);
    expect(entryLandedOnDay(entry, '2026-07-03', 'America/Toronto')).toBe(false);
  });

  test('morning Toronto entry lands on same UTC/Toronto day', () => {
    // 2026-07-02 09:00 Toronto == 2026-07-02T13:00Z
    const entry = { date: '2026-07-02', timestamp: '2026-07-02T13:00:00.000Z' };
    expect(entryLandedOnDay(entry, '2026-07-02', 'America/Toronto')).toBe(true);
  });

  test('just-after-midnight Toronto entry lands on the new Toronto day', () => {
    // 2026-07-02 00:30 America/Toronto (EDT, -04:00) == 2026-07-02T04:30Z
    const entry = { date: '2026-07-02', timestamp: '2026-07-02T04:30:00.000Z' };
    expect(entryLandedOnDay(entry, '2026-07-02', 'America/Toronto')).toBe(true);
    expect(entryLandedOnDay(entry, '2026-07-01', 'America/Toronto')).toBe(false);
  });

  test('KNOWN LIMITATION: timestamp-less evening entry attributes to the UTC day', () => {
    // An entry written 20:00-23:59 Toronto WITHOUT a timestamp carries the
    // next UTC day in `date`; the fallback can only trust that field, so it
    // buckets to the UTC day, not the true Toronto day. Both production
    // writers always set `timestamp` (recon-verified), so this is a rare
    // degraded mode — asserted here so the behavior is explicit, not silent.
    const entry = { date: '2026-07-03' }; // written 2026-07-02 evening Toronto
    expect(entryLandedOnDay(entry, '2026-07-02', 'America/Toronto')).toBe(false);
    expect(entryLandedOnDay(entry, '2026-07-03', 'America/Toronto')).toBe(true);
  });

  test('falls back to date field when timestamp is missing', () => {
    const entry = { date: '2026-07-02' };
    expect(entryLandedOnDay(entry, '2026-07-02', 'America/Toronto')).toBe(true);
    expect(entryLandedOnDay(entry, '2026-07-01', 'America/Toronto')).toBe(false);
  });

  test('falls back to date field when timestamp is garbage', () => {
    const entry = { date: '2026-07-02', timestamp: 'not-a-date' };
    expect(entryLandedOnDay(entry, '2026-07-02', 'America/Toronto')).toBe(true);
  });

  test('mealType filter excludes non-matching meals', () => {
    const entry = {
      date: '2026-07-02',
      timestamp: '2026-07-02T13:00:00.000Z',
      mealType: 'lunch',
    };
    expect(entryLandedOnDay(entry, '2026-07-02', 'America/Toronto', 'breakfast')).toBe(false);
    expect(entryLandedOnDay(entry, '2026-07-02', 'America/Toronto', 'lunch')).toBe(true);
  });
});

describe('resolveCheckFile', () => {
  test('weight and meal map to the right files', () => {
    expect(resolveCheckFile({ kind: 'weight' })).toContain('meal-data/weight-data.json');
    expect(resolveCheckFile({ kind: 'meal' })).toContain('meal-data/meal-log.json');
  });
});

describe('sweepCompletions — error swallowing', () => {
  test('missing file does not throw; error is logged; upsert still runs', () => {
    dbMocks.getTasksWithChecks.mockReturnValue([
      { id: 'task-1', completion_check: JSON.stringify({ kind: 'weight' }) },
    ]);
    fsMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(() => sweepCompletions(Date.parse('2026-07-02T18:00:00.000Z'))).not.toThrow();
    expect(loggerMocks.logger.error).toHaveBeenCalled();
    // 3 days swept even though the file is missing (all data_landed=0).
    expect(dbMocks.upsertCompletionLog).toHaveBeenCalledTimes(3);
  });

  test('no tasks -> no reads, no throw', () => {
    dbMocks.getTasksWithChecks.mockReturnValue([]);
    expect(() => sweepCompletions()).not.toThrow();
    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
  });
});

describe('checkLandedToday — live on-demand landing evaluation', () => {
  const NOW = Date.parse('2026-07-05T18:00:00.000Z'); // 2026-07-05 14:00 Toronto

  test('landed today: upserts landed row and clears the escalation flag', () => {
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        entries: [{ date: '2026-07-05', timestamp: '2026-07-05T13:00:00.000Z' }],
      }),
    );

    const landed = checkLandedToday(
      { id: 'weight-task', completion_check: JSON.stringify({ kind: 'weight' }) },
      NOW,
    );

    expect(landed).toBe(true);
    expect(dbMocks.upsertCompletionLog).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertCompletionLog).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'weight-task', day: '2026-07-05', dataLanded: true }),
    );
    expect(dbMocks.clearTaskNudgeEscalation).toHaveBeenCalledWith('weight-task');
  });

  test('not landed today: upserts a not-landed row and never clears escalation', () => {
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ entries: [] }));

    const landed = checkLandedToday(
      { id: 'weight-task', completion_check: JSON.stringify({ kind: 'weight' }) },
      NOW,
    );

    expect(landed).toBe(false);
    expect(dbMocks.upsertCompletionLog).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'weight-task', day: '2026-07-05', dataLanded: false }),
    );
    expect(dbMocks.clearTaskNudgeEscalation).not.toHaveBeenCalled();
  });

  test('no completion_check: returns false, no db writes, no file read', () => {
    const landed = checkLandedToday({ id: 'plain-task', completion_check: null }, NOW);
    expect(landed).toBe(false);
    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
    expect(dbMocks.upsertCompletionLog).not.toHaveBeenCalled();
  });
});

describe('consecutiveMissedDays — counts contiguous tracker-active misses backwards from yesterday', () => {
  const NOW = Date.parse('2026-07-05T18:00:00.000Z'); // today = 2026-07-05 Toronto

  test('no history rows: zero missed', () => {
    dbMocks.getTaskCompletionHistoryBefore.mockReturnValue([]);
    expect(consecutiveMissedDays('t', NOW)).toBe(0);
  });

  test('three contiguous missed days: returns 3', () => {
    dbMocks.getTaskCompletionHistoryBefore.mockReturnValue([
      { day: '2026-07-04', dataLanded: false },
      { day: '2026-07-03', dataLanded: false },
      { day: '2026-07-02', dataLanded: false },
    ]);
    expect(consecutiveMissedDays('t', NOW)).toBe(3);
  });

  test('stops counting at the first landed day', () => {
    dbMocks.getTaskCompletionHistoryBefore.mockReturnValue([
      { day: '2026-07-04', dataLanded: false },
      { day: '2026-07-03', dataLanded: true }, // landed — stop here
      { day: '2026-07-02', dataLanded: false },
    ]);
    expect(consecutiveMissedDays('t', NOW)).toBe(1);
  });

  test('stops at a calendar gap (missing row) — tracker was inactive that day', () => {
    // Yesterday missed, but the day before that (2026-07-03) has no row: the
    // next row jumps to 2026-07-02, breaking the contiguous chain.
    dbMocks.getTaskCompletionHistoryBefore.mockReturnValue([
      { day: '2026-07-04', dataLanded: false },
      { day: '2026-07-02', dataLanded: false },
    ]);
    expect(consecutiveMissedDays('t', NOW)).toBe(1);
  });

  test('gap at yesterday itself (most recent row is older than yesterday) → zero', () => {
    dbMocks.getTaskCompletionHistoryBefore.mockReturnValue([
      { day: '2026-07-03', dataLanded: false },
      { day: '2026-07-02', dataLanded: false },
    ]);
    expect(consecutiveMissedDays('t', NOW)).toBe(0);
  });
});

describe('sweepCompletions — stats snapshot', () => {
  test('writes nudge-stats.json atomically (tmp write then rename) with the expected shape', () => {
    dbMocks.getTasksWithChecks.mockReturnValue([
      {
        id: 'weight-task-abcdef12',
        completion_check: JSON.stringify({ kind: 'meal', mealType: 'breakfast' }),
        nudge_escalated_day: '2026-07-04',
      },
    ]);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ entries: [] }));
    dbMocks.countLandedDays.mockReturnValue(4);
    dbMocks.getTaskLandedDays.mockReturnValue(new Set<string>());
    dbMocks.getTaskCompletionHistoryBefore.mockReturnValue([]);

    sweepCompletions(Date.parse('2026-07-05T18:00:00.000Z'));

    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fsMocks.renameSync).toHaveBeenCalledTimes(1);

    const [tmpPath, contents] = fsMocks.writeFileSync.mock.calls[0];
    const [renameFrom, renameTo] = fsMocks.renameSync.mock.calls[0];
    // Atomic discipline: write to a .tmp sibling, then rename onto the target.
    expect(String(tmpPath)).toMatch(/nudge-stats\.json\.tmp$/);
    expect(renameFrom).toBe(tmpPath);
    expect(String(renameTo)).toMatch(/nudge-stats\.json$/);

    const payload = JSON.parse(String(contents)) as {
      generatedAt: string;
      dataDaysThisWeek: number;
      tasks: Array<{
        id8: string;
        kind: string;
        last7: Array<{ day: string; landed: boolean }>;
        escalated: boolean;
        consecutiveMissed: number;
      }>;
    };
    expect(payload.generatedAt).toBe('2026-07-05T18:00:00.000Z');
    expect(payload.dataDaysThisWeek).toBe(4);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0].id8).toBe('weight-t'); // 8-char slice
    expect(payload.tasks[0].kind).toBe('meal:breakfast');
    expect(payload.tasks[0].escalated).toBe(true);
    expect(payload.tasks[0].last7).toHaveLength(7);
    expect(payload.tasks[0].consecutiveMissed).toBe(0);
  });

  test('snapshot write failure is swallowed — sweep never throws', () => {
    dbMocks.getTasksWithChecks.mockReturnValue([]);
    fsMocks.renameSync.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => sweepCompletions(Date.parse('2026-07-05T18:00:00.000Z'))).not.toThrow();
    expect(loggerMocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'disk full' }),
      'Completion sweep: failed to write stats snapshot (swallowed)',
    );
  });
});

// Migration + upsert exercised against an in-memory better-sqlite3 db that
// REPLICATES the schema. HONEST NOTE: db.ts hardcodes its path via
// initDatabase() and getDb() is private, so the real module cannot be pointed
// at ':memory:'. We therefore assert the SQL statements' behaviour on a
// faithful replica.
describe('migration idempotency + upsert (in-memory replica)', () => {
  function freshDb(): Database.Database {
    const d = new Database(':memory:');
    d.exec(`
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, prompt TEXT NOT NULL,
        schedule TEXT NOT NULL, next_run INTEGER NOT NULL, last_run INTEGER,
        last_result TEXT, status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
    `);
    return d;
  }

  function migrate(d: Database.Database): void {
    const cols = d.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'completion_check')) {
      d.exec('ALTER TABLE scheduled_tasks ADD COLUMN completion_check TEXT NULL;');
    }
    d.exec(`
      CREATE TABLE IF NOT EXISTS task_completion_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, day TEXT NOT NULL,
        data_landed INTEGER NOT NULL DEFAULT 0, landed_at INTEGER, checked_at INTEGER NOT NULL,
        UNIQUE(task_id, day)
      );
    `);
  }

  test('migration is idempotent — running twice does not throw or duplicate column', () => {
    const d = freshDb();
    migrate(d);
    expect(() => migrate(d)).not.toThrow();
    const cols = d.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'completion_check')).toHaveLength(1);
  });

  test('upsert overwrites on (task_id, day) conflict', () => {
    const d = freshDb();
    migrate(d);
    const up = d.prepare(`
      INSERT INTO task_completion_log (task_id, day, data_landed, landed_at, checked_at)
      VALUES (@task_id, @day, @data_landed, @landed_at, @checked_at)
      ON CONFLICT(task_id, day) DO UPDATE SET
        data_landed = excluded.data_landed,
        landed_at   = excluded.landed_at,
        checked_at  = excluded.checked_at
    `);
    up.run({ task_id: 't', day: '2026-07-02', data_landed: 0, landed_at: null, checked_at: 1 });
    up.run({ task_id: 't', day: '2026-07-02', data_landed: 1, landed_at: 999, checked_at: 2 });

    const rows = d.prepare('SELECT * FROM task_completion_log').all() as Array<{
      data_landed: number;
      landed_at: number | null;
      checked_at: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].data_landed).toBe(1);
    expect(rows[0].landed_at).toBe(999);
    expect(rows[0].checked_at).toBe(2);
  });
});
