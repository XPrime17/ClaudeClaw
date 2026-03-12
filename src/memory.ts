import {
  searchMemories,
  getMemories,
  touchMemory,
  saveMemory,
  decayMemories,
  deleteStaleMemories,
  type Memory,
} from './db.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Build memory context to inject into the agent prompt
// ---------------------------------------------------------------------------

export function buildMemoryContext(chatId: string, userMessage: string): string {
  // 1. FTS5 search — top 3 matches by relevance
  const ftsResults = searchMemories(chatId, userMessage, 3);

  // 2. Recent memories — top 5 by last access time
  const recentResults = getMemories(chatId, {
    limit: 5,
    orderBy: 'accessed_at DESC',
  });

  // 3. Deduplicate by id
  const seen = new Set<number>();
  const combined: Memory[] = [];

  for (const m of [...ftsResults, ...recentResults]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    combined.push(m);
  }

  if (combined.length === 0) return '';

  // 4. Touch each surfaced memory (salience += 0.1, capped at 5.0)
  for (const m of combined) {
    touchMemory(m.id, 0.1);
  }

  // 5. Format as context block
  const lines = combined.map((m) => `- ${m.content} (${m.sector})`);
  return `[Memory context]\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Save a conversation turn as a memory
// ---------------------------------------------------------------------------

const SEMANTIC_SIGNAL =
  /\b(my|i am|i'm|i prefer|remember|always|never)\b/i;

export function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string
): void {
  // Skip trivially short messages
  if (userMsg.length <= 20) return;

  // Skip commands
  if (userMsg.startsWith('/')) return;

  const isSemanticSignal = SEMANTIC_SIGNAL.test(userMsg);
  const sector: 'semantic' | 'episodic' = isSemanticSignal
    ? 'semantic'
    : 'episodic';

  // Store the user's statement as the memory content
  saveMemory(chatId, userMsg, sector, { salience: 1.0 });

  logger.debug(
    { chatId, sector, len: userMsg.length },
    'Saved conversation turn to memory'
  );
}

// ---------------------------------------------------------------------------
// Periodic decay sweep
// ---------------------------------------------------------------------------

export function runDecaySweep(): void {
  const { decayed, deleted } = decayMemories();
  logger.info({ decayed, deleted }, 'Memory decay sweep completed');

  // Also clean up very old low-salience memories (older than 30 days)
  const staleDeleted = deleteStaleMemories(30 * 86_400_000);
  if (staleDeleted > 0) {
    logger.info({ staleDeleted }, 'Deleted stale memories');
  }
}
