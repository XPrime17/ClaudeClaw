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
  // Track the last assistant text we saw. When `claude` fails (e.g. expired
  // login), the SDK throws a generic "process exited with code 1" but the real
  // reason — "Not logged in · Please run /login" — is delivered as a synthetic
  // assistant message first. Capturing it makes the failure diagnosable in the
  // logs instead of opaque.
  let lastAssistantText: string | null = null;

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
      if (event.type === 'assistant') {
        const content = (event as any).message?.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('')
            .trim();
          if (text) lastAssistantText = text;
        }
      }
      if (event.type === 'result') {
        if (event.subtype === 'success') {
          resultText = (event as SDKResultSuccess).result ?? null;
        } else {
          // Error result — surface the actual assistant text when present.
          logger.warn(
            { subtype: event.subtype, detail: lastAssistantText },
            'Agent returned non-success result',
          );
          resultText = lastAssistantText || `Error: ${event.subtype}`;
        }
      }
    }
  } catch (err: any) {
    // The SDK collapses subprocess failures into "process exited with code 1".
    // Re-attach the real reason (e.g. the login prompt) so it lands in the log.
    logger.error(
      { err: err.message, detail: lastAssistantText },
      'Agent query failed',
    );
    if (lastAssistantText && /not logged in|please run \/login/i.test(lastAssistantText)) {
      throw new Error(
        `Claude Code is not logged in (${lastAssistantText}). Run \`claude\` once to re-authenticate.`,
      );
    }
    if (lastAssistantText) {
      throw new Error(`${err.message} — ${lastAssistantText}`);
    }
    throw err;
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }

  return { text: resultText, newSessionId };
}
