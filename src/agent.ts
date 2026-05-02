import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_CWD } from './config.js';
import { logger } from './logger.js';

// Scrub Claude Code sentinel env vars so the spawned `claude` subprocess
// doesn't trip the "cannot be launched inside another Claude Code session"
// guard when this service was started from a polluted environment.
for (const key of [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
]) {
  delete process.env[key];
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void
): Promise<{ text: string | null; newSessionId?: string }> {
  let newSessionId: string | undefined;
  let resultText: string | null = null;

  const typingInterval = onTyping ? setInterval(onTyping, 4000) : null;

  try {
    const events = query({
      prompt: message,
      options: {
        cwd: AGENT_CWD,
        ...(sessionId ? { resume: sessionId } : {}),
        settingSources: ['project', 'user'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    });

    for await (const event of events) {
      if (event.type === 'system' && event.subtype === 'init') {
        newSessionId = event.session_id;
      }
      if (event.type === 'result') {
        if (event.subtype === 'success') {
          resultText = (event as SDKResultSuccess).result ?? null;
        } else {
          // Error result — extract error messages
          logger.warn({ subtype: event.subtype }, 'Agent returned non-success result');
          resultText = `Error: ${event.subtype}`;
        }
      }
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Agent query failed');
    throw err;
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }

  return { text: resultText, newSessionId };
}
