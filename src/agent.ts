import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultSuccess, SDKResultError } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_CWD } from './config.js';
import { logger } from './logger.js';

/** Structured diagnostics for an SDK-returned (non-success) result. */
export interface AgentError {
  /** SDK result subtype, e.g. 'error_max_turns', 'error_during_execution'. */
  type: string;
  /** Error strings the SDK attached to the result (SDKResultError.errors). */
  messages: string[];
  /** Last assistant text seen — often the human-readable reason. */
  detail?: string;
  /** How many turns the agent took before the error. */
  numTurns?: number;
  /** How many tool calls were denied by permissions. */
  permissionDenials?: number;
}

export interface AgentResult {
  /** Final (or partial) assistant text, if any. */
  text: string | null;
  /** Session id to resume next time. */
  newSessionId?: string;
  /** Present only when the SDK returned a non-success result. */
  error?: AgentError;
}

/** Render an AgentError as a concise, user-facing diagnostic for Telegram. */
export function formatAgentError(error: AgentError): string {
  const lines: string[] = [`⚠️ Agent error (${error.type})`];
  const body = (error.messages.length ? error.messages.join('\n') : error.detail || '').trim();
  if (body) lines.push(body);
  const meta: string[] = [];
  if (typeof error.numTurns === 'number') meta.push(`turns: ${error.numTurns}`);
  if (error.permissionDenials) meta.push(`denied tools: ${error.permissionDenials}`);
  if (meta.length) lines.push(`(${meta.join(', ')})`);
  return lines.join('\n');
}

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
): Promise<AgentResult> {
  let newSessionId: string | undefined;
  let resultText: string | null = null;
  let agentError: AgentError | undefined;
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
          // Non-success result — capture structured diagnostics so the caller
          // can report the real error to the user instead of treating it as a
          // normal reply.
          const er = event as SDKResultError;
          agentError = {
            type: er.subtype,
            messages: Array.isArray(er.errors) ? er.errors : [],
            detail: lastAssistantText ?? undefined,
            numTurns: er.num_turns,
            permissionDenials: er.permission_denials?.length ?? 0,
          };
          logger.warn(
            { subtype: er.subtype, errors: agentError.messages, detail: lastAssistantText },
            'Agent returned non-success result',
          );
          // Keep any partial assistant text so the user still sees it.
          resultText = lastAssistantText ?? null;
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

  return { text: resultText, newSessionId, error: agentError };
}
