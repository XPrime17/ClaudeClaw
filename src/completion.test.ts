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
}));

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock('./config.js', () => configMocks);
vi.mock('./db.js', () => dbMocks);
vi.mock('fs', () => fsMocks);
vi.mock('./logger.js', () => loggerMocks);

import { entryLandedOnDay, sweepCompletions, resolveCheckFile } from './completion.js';

afterEach(() => {
  vi.clearAllMocks();
  dbMocks.getTasksWithChecks.mockReturnValue([]);
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
