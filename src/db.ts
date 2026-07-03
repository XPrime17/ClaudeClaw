import Database from 'better-sqlite3';
import { join } from 'path';
import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------
let db: Database.Database;

export function initDatabase(): Database.Database {
  if (db) return db;

  const dbPath = join(STORE_DIR, 'claudeclaw.db');
  db = new Database(dbPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id    TEXT    PRIMARY KEY,
      session_id TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // -------------------------------------------------------------------------
  // Memories (dual-sector: semantic + episodic)
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT    NOT NULL,
      topic_key   TEXT,
      content     TEXT    NOT NULL,
      sector      TEXT    NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience    REAL    NOT NULL DEFAULT 1.0,
      created_at  INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    );
  `);

  // FTS5 virtual table for full-text search on memory content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(content, content_rowid='id');
  `);

  // Triggers to keep FTS in sync with the memories table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      UPDATE memories_fts SET content = new.content WHERE rowid = old.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.id;
    END;
  `);

  // -------------------------------------------------------------------------
  // Scheduled tasks
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT    PRIMARY KEY,
      chat_id     TEXT    NOT NULL,
      prompt      TEXT    NOT NULL,
      schedule    TEXT    NOT NULL,
      next_run    INTEGER NOT NULL,
      last_run    INTEGER,
      last_result TEXT,
      status      TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at  INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_next
      ON scheduled_tasks(status, next_run);
  `);

  // -------------------------------------------------------------------------
  // WhatsApp outbox
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_outbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid   TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      status     TEXT    NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
  `);

  // -------------------------------------------------------------------------
  // WhatsApp message log
  // -------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid    TEXT    NOT NULL,
      sender      TEXT,
      content     TEXT    NOT NULL,
      is_incoming INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
  `);

  logger.info({ dbPath }, 'Database initialised');
  return db;
}

function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised — call initDatabase() first');
  return db;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function getSession(chatId: string): string | null {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setSession(chatId: string, sessionId: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (chat_id, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`
    )
    .run(chatId, sessionId, Date.now());
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

export interface Memory {
  id: number;
  chat_id: string;
  topic_key: string | null;
  content: string;
  sector: 'semantic' | 'episodic';
  salience: number;
  created_at: number;
  accessed_at: number;
}

export function getMemories(
  chatId: string,
  opts?: { sector?: string; limit?: number; orderBy?: string }
): Memory[] {
  const limit = opts?.limit ?? 20;
  const orderBy = opts?.orderBy ?? 'accessed_at DESC';
  let sql = 'SELECT * FROM memories WHERE chat_id = ?';
  const params: any[] = [chatId];

  if (opts?.sector) {
    sql += ' AND sector = ?';
    params.push(opts.sector);
  }

  sql += ` ORDER BY ${orderBy} LIMIT ?`;
  params.push(limit);

  return getDb().prepare(sql).all(...params) as Memory[];
}

export function saveMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  opts?: { topicKey?: string; salience?: number }
): number {
  const now = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      chatId,
      opts?.topicKey ?? null,
      content,
      sector,
      opts?.salience ?? 1.0,
      now,
      now
    );
  return Number(info.lastInsertRowid);
}

export function searchMemories(
  chatId: string,
  queryText: string,
  limit = 3
): Memory[] {
  // Sanitise FTS5 query: strip special chars, append prefix matching
  const sanitised = queryText.replace(/[^\w\s]/g, '').trim();
  if (!sanitised) return [];

  const ftsQuery = sanitised
    .split(/\s+/)
    .map((t) => `${t}*`)
    .join(' ');

  return getDb()
    .prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts f ON f.rowid = m.id
       WHERE f.content MATCH ? AND m.chat_id = ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(ftsQuery, chatId, limit) as Memory[];
}

export function touchMemory(id: number, salienceBoost = 0.1): void {
  getDb()
    .prepare(
      `UPDATE memories
       SET accessed_at = ?,
           salience    = MIN(salience + ?, 5.0)
       WHERE id = ?`
    )
    .run(Date.now(), salienceBoost, id);
}

export function decayMemories(): { decayed: number; deleted: number } {
  const oneDayAgo = Date.now() - 86_400_000;

  const decayResult = getDb()
    .prepare(
      `UPDATE memories SET salience = salience * 0.98
       WHERE created_at < ?`
    )
    .run(oneDayAgo);

  const deleteResult = getDb()
    .prepare('DELETE FROM memories WHERE salience < 0.1')
    .run();

  return {
    decayed: decayResult.changes,
    deleted: deleteResult.changes,
  };
}

export function deleteStaleMemories(maxAge: number): number {
  const cutoff = Date.now() - maxAge;
  const result = getDb()
    .prepare('DELETE FROM memories WHERE accessed_at < ? AND salience < 0.3')
    .run(cutoff);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

export interface ScheduledTask {
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

export function createTask(task: {
  id: string;
  chatId: string;
  prompt: string;
  schedule: string;
  nextRun: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(task.id, task.chatId, task.prompt, task.schedule, task.nextRun, Date.now());
}

export function getDueTasks(): ScheduledTask[] {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run <= ?
       ORDER BY next_run ASC`
    )
    .all(Date.now()) as ScheduledTask[];
}

export function getActiveTasks(): ScheduledTask[] {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active'
       ORDER BY next_run ASC`
    )
    .all() as ScheduledTask[];
}

export function setTaskNextRun(id: string, nextRun: number): void {
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET next_run = ?
       WHERE id = ?`
    )
    .run(nextRun, id);
}

/**
 * Atomically claim a due task by advancing its next_run past `now`.
 * Guards against two schedulers (or a double loop) executing the same task:
 * only the executor whose UPDATE actually mutates a row (changes === 1) owns
 * the run. Returns false if another executor already claimed it.
 */
export function claimTask(id: string, newNextRun: number, now: number): boolean {
  const result = getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET next_run = ?
       WHERE id = ? AND next_run <= ?`
    )
    .run(newNextRun, id, now);
  return result.changes > 0;
}

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string
): void {
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_run = ?, last_result = ?, next_run = ?
       WHERE id = ?`
    )
    .run(Date.now(), result, nextRun, id);
}

export function listTasks(chatId: string): ScheduledTask[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks WHERE chat_id = ? ORDER BY next_run ASC')
    .all(chatId) as ScheduledTask[];
}

export function deleteTask(id: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM scheduled_tasks WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

export function pauseTask(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function resumeTask(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// WhatsApp outbox
// ---------------------------------------------------------------------------

export function queueWaMessage(chatJid: string, content: string): number {
  const info = getDb()
    .prepare(
      `INSERT INTO wa_outbox (chat_jid, content, status, created_at)
       VALUES (?, ?, 'pending', ?)`
    )
    .run(chatJid, content, Date.now());
  return Number(info.lastInsertRowid);
}

export function getWaPending(): Array<{
  id: number;
  chat_jid: string;
  content: string;
}> {
  return getDb()
    .prepare(
      "SELECT id, chat_jid, content FROM wa_outbox WHERE status = 'pending' ORDER BY id ASC"
    )
    .all() as Array<{ id: number; chat_jid: string; content: string }>;
}

export function markWaSent(id: number): void {
  getDb()
    .prepare("UPDATE wa_outbox SET status = 'sent' WHERE id = ?")
    .run(id);
}

// ---------------------------------------------------------------------------
// WhatsApp message log
// ---------------------------------------------------------------------------

export function saveWaMessage(msg: {
  chatJid: string;
  sender?: string;
  content: string;
  isIncoming: boolean;
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO wa_messages (chat_jid, sender, content, is_incoming, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(msg.chatJid, msg.sender ?? null, msg.content, msg.isIncoming ? 1 : 0, Date.now());
  return Number(info.lastInsertRowid);
}

export function getWaMessages(
  chatJid: string,
  limit = 50
): Array<{
  id: number;
  chat_jid: string;
  sender: string | null;
  content: string;
  is_incoming: number;
  created_at: number;
}> {
  return getDb()
    .prepare(
      `SELECT * FROM wa_messages WHERE chat_jid = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(chatJid, limit) as any[];
}
