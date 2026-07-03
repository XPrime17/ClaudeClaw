/**
 * bot.ts — Grammy-based Telegram bot for ClaudeClaw.
 *
 * Handles commands, text messages, voice notes, photos, documents, and video.
 * Routes everything through the Claude Code agent and formats responses for
 * Telegram's HTML parse mode.
 */

import { Bot, Context } from 'grammy';
import { randomUUID } from 'crypto';
import cronParser from 'cron-parser';
const { parseExpression } = cronParser;

import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  TIMEZONE,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
} from './config.js';
import { logger } from './logger.js';
import {
  getSession,
  clearSession,
  setSession,
  getMemories,
  createTask,
  listTasks,
  deleteTask,
  pauseTask,
  resumeTask,
} from './db.js';
import { runAgent, formatAgentError } from './agent.js';
import { buildMemoryContext, saveConversationTurn } from './memory.js';
import { transcribeAudio, voiceCapabilities } from './voice.js';
import {
  downloadMedia,
  buildPhotoMessage,
  buildDocumentMessage,
  buildVideoMessage,
  cleanupOldUploads,
} from './media.js';
import { initScheduler, computeNextRun } from './scheduler.js';

// ---------------------------------------------------------------------------
// Formatting: Markdown -> Telegram HTML
// ---------------------------------------------------------------------------

/**
 * Convert a Markdown-ish string to Telegram-compatible HTML.
 *
 * Order of operations matters:
 * 1. Extract code blocks into placeholders (protect from further transforms)
 * 2. Escape HTML entities in the remaining text
 * 3. Apply inline conversions (bold, italic, strike, links, etc.)
 * 4. Restore code blocks
 */
export function formatForTelegram(text: string): string {
  // Step 1 — extract fenced code blocks
  const codeBlocks: string[] = [];
  let working = text.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_match, lang, code) => {
      const idx = codeBlocks.length;
      // Escape HTML inside code blocks
      const escaped = escapeHtml(code.replace(/\n$/, ''));
      codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
      return `\x00CODEBLOCK_${idx}\x00`;
    },
  );

  // Step 2 — extract inline code
  const inlineCode: string[] = [];
  working = working.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE_${idx}\x00`;
  });

  // Step 3 — escape HTML entities in normal text
  working = escapeHtml(working);

  // Step 4 — Markdown -> HTML conversions
  // Bold: **text** or __text__
  working = working.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  working = working.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words with underscores)
  working = working.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  working = working.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  working = working.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  working = working.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  // Headings: # Heading -> bold (Telegram has no heading tag)
  working = working.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Checkboxes
  working = working.replace(/- \[ \]/g, '\u2610');
  working = working.replace(/- \[x\]/gi, '\u2611');

  // Horizontal rules / separators
  working = working.replace(/^(-{3,}|\*{3,})$/gm, '');

  // Strip any remaining raw HTML tags that Telegram doesn't support
  working = working.replace(
    /<\/?(?!b|i|s|u|a|code|pre|strike|strong|em)\w[^>]*>/g,
    '',
  );

  // Step 5 — restore code blocks and inline code
  for (let i = 0; i < inlineCode.length; i++) {
    working = working.replace(`\x00INLINE_${i}\x00`, inlineCode[i]);
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    working = working.replace(`\x00CODEBLOCK_${i}\x00`, codeBlocks[i]);
  }

  return working.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Message splitting
// ---------------------------------------------------------------------------

/**
 * Split a message into chunks that fit within Telegram's character limit.
 * Splits on newlines to avoid breaking mid-word or mid-tag.
 */
export function splitMessage(
  text: string,
  limit: number = MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find the last newline before the limit
    let splitIdx = remaining.lastIndexOf('\n', limit);
    if (splitIdx <= 0) {
      // No newline found — find the last space
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx <= 0) {
      // No space found either — hard cut at limit
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

function isAuthorised(chatId: number): boolean {
  if (!ALLOWED_CHAT_ID) {
    // First-run mode: no restriction configured
    return true;
  }
  const allowed = ALLOWED_CHAT_ID.split(',').map((s) => s.trim());
  return allowed.includes(String(chatId));
}

// ---------------------------------------------------------------------------
// Send helper — tries HTML, falls back to plain text
// ---------------------------------------------------------------------------

async function safeSend(
  bot: Bot,
  chatId: number | string,
  text: string,
): Promise<void> {
  const numericId = typeof chatId === 'string' ? Number(chatId) : chatId;
  const formatted = formatForTelegram(text);
  const chunks = splitMessage(formatted);

  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(numericId, chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (err: any) {
      // HTML parse failure — retry without formatting
      if (
        err.message?.includes('parse') ||
        err.description?.includes('parse')
      ) {
        logger.warn('HTML parse failed, retrying as plain text');
        const plainChunks = splitMessage(text);
        for (const plain of plainChunks) {
          await bot.api.sendMessage(numericId, plain, { link_preview_options: { is_disabled: true } });
        }
        return; // sent as plain, done
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Core message handler
// ---------------------------------------------------------------------------

const voiceModeChats = new Set<number>();

async function handleMessage(
  bot: Bot,
  chatId: number,
  userMessage: string,
  username?: string,
): Promise<void> {
  // Build memory context for the agent
  const memoryContext = buildMemoryContext(String(chatId), userMessage);

  // Retrieve or start a conversation session
  const sessionId = getSession(String(chatId));

  // Start typing indicator (refresh every 4s so it doesn't expire)
  let typing = true;
  const typingLoop = (async () => {
    while (typing) {
      try {
        await bot.api.sendChatAction(chatId, 'typing');
      } catch {
        // ignore typing errors
      }
      await new Promise((r) => setTimeout(r, TYPING_REFRESH_MS));
    }
  })();

  try {
    // Run through Claude Code agent
    const prompt = memoryContext
      ? `${memoryContext}\n\nUser message: ${userMessage}`
      : userMessage;

    const result = await runAgent(prompt, sessionId ?? undefined);

    // Stop typing
    typing = false;

    // Persist session even on error so the next message can resume.
    if (result.newSessionId) {
      setSession(String(chatId), result.newSessionId);
    }

    // SDK returned a non-success result (max turns, execution error, etc.).
    // Report the diagnostic to the user instead of silently passing it off as
    // a normal reply. Include any partial output the agent did produce.
    if (result.error) {
      logger.warn({ chatId, error: result.error }, 'Agent returned SDK error to user');
      if (result.text) {
        await safeSend(bot, chatId, result.text);
      }
      await safeSend(bot, chatId, formatAgentError(result.error));
      return;
    }

    if (!result.text) {
      await bot.api.sendMessage(chatId, '(no response from agent)');
      return;
    }

    // Save conversation turn for memory
    saveConversationTurn(String(chatId), userMessage, result.text);

    // Send formatted response
    await safeSend(bot, chatId, result.text);
  } catch (err: any) {
    typing = false;
    logger.error({ err: err.message, chatId }, 'Agent execution failed');
    await bot.api.sendMessage(
      chatId,
      `Something went wrong: ${err.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Schedule command — inline task management
// ---------------------------------------------------------------------------

async function handleScheduleCommand(
  bot: Bot,
  ctx: Context,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const text = ctx.message?.text || '';
  const parts = text.replace(/^\/schedule\s*/, '').trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand || subcommand === 'help') {
    await bot.api.sendMessage(
      chatId,
      [
        '<b>Schedule Commands</b>',
        '',
        '<code>/schedule create &lt;cron&gt; &lt;prompt&gt;</code>',
        '  Create a scheduled task',
        '',
        '<code>/schedule list</code>',
        '  List your scheduled tasks',
        '',
        '<code>/schedule delete &lt;task_id&gt;</code>',
        '  Delete a task',
        '',
        '<code>/schedule pause &lt;task_id&gt;</code>',
        '  Pause a task',
        '',
        '<code>/schedule resume &lt;task_id&gt;</code>',
        '  Resume a paused task',
        '',
        '<b>Cron examples:</b>',
        '  <code>0 9 * * *</code> — daily at 9 AM',
        '  <code>*/30 * * * *</code> — every 30 minutes',
        '  <code>0 0 * * 1</code> — weekly on Monday',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
    return;
  }

  switch (subcommand) {
    case 'create': {
      // /schedule create "0 9 * * *" Summarize my unread emails
      const cronMatch = text.match(
        /create\s+["']?([0-9*/,\- ]{9,})["']?\s+(.+)/i,
      );
      if (!cronMatch) {
        await bot.api.sendMessage(
          chatId,
          'Usage: /schedule create <cron> <prompt>\nExample: /schedule create 0 9 * * * Send me a daily summary',
        );
        return;
      }
      const cron = cronMatch[1].trim();
      const prompt = cronMatch[2].trim();

      try {
        parseExpression(cron);
      } catch {
        await bot.api.sendMessage(chatId, `Invalid cron expression: "${cron}"`);
        return;
      }

      const id = randomUUID();
      const nextRun = computeNextRun(cron);
      createTask({
        id,
        chatId: String(chatId),
        schedule: cron,
        prompt,
        nextRun,
      });

      await bot.api.sendMessage(
        chatId,
        [
          `Task created!`,
          `ID: <code>${id.slice(0, 8)}...</code>`,
          `Schedule: <code>${cron}</code>`,
          `Prompt: ${prompt}`,
          `Next run: ${new Date(nextRun).toLocaleString('en-CA', { timeZone: TIMEZONE })} (${TIMEZONE})`,
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
      break;
    }

    case 'list': {
      const tasks = listTasks(String(chatId));
      if (tasks.length === 0) {
        await bot.api.sendMessage(chatId, 'No scheduled tasks.');
        return;
      }
      const lines = tasks.map((t: any) => {
        const status = t.status === 'active' ? 'Active' : 'Paused';
        const next = t.next_run
          ? `${new Date(t.next_run).toLocaleString('en-CA', { timeZone: TIMEZONE })} (${TIMEZONE})`
          : '-';
        return [
          `<b>${t.id.slice(0, 8)}...</b> [${status}]`,
          `  <code>${t.schedule}</code> | Next: ${next}`,
          `  ${t.prompt.slice(0, 80)}`,
        ].join('\n');
      });
      await bot.api.sendMessage(chatId, lines.join('\n\n'), {
        parse_mode: 'HTML',
      });
      break;
    }

    case 'delete': {
      const taskId = parts[1];
      if (!taskId) {
        await bot.api.sendMessage(chatId, 'Usage: /schedule delete <task_id>');
        return;
      }
      deleteTask(taskId);
      await bot.api.sendMessage(chatId, `Deleted task: ${taskId}`);
      break;
    }

    case 'pause': {
      const taskId = parts[1];
      if (!taskId) {
        await bot.api.sendMessage(chatId, 'Usage: /schedule pause <task_id>');
        return;
      }
      pauseTask(taskId);
      await bot.api.sendMessage(chatId, `Paused task: ${taskId}`);
      break;
    }

    case 'resume': {
      const taskId = parts[1];
      if (!taskId) {
        await bot.api.sendMessage(chatId, 'Usage: /schedule resume <task_id>');
        return;
      }
      resumeTask(taskId);
      await bot.api.sendMessage(chatId, `Resumed task: ${taskId}`);
      break;
    }

    default:
      await bot.api.sendMessage(
        chatId,
        `Unknown schedule subcommand: "${subcommand}". Try /schedule help`,
      );
  }
}

// ---------------------------------------------------------------------------
// Bot factory
// ---------------------------------------------------------------------------

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN not set in .env');
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  // --- Command handlers ---

  bot.command('start', async (ctx) => {
    await ctx.reply(
      "Hey! I'm Bumble Bee, Scott's personal assistant. Send me a message and I'll get to work.",
    );
  });

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('newchat', async (ctx) => {
    clearSession(String(ctx.chat.id));
    await ctx.reply('Session cleared. Starting fresh.');
  });

  bot.command('forget', async (ctx) => {
    clearSession(String(ctx.chat.id));
    await ctx.reply('Session cleared. Starting fresh.');
  });

  bot.command('memory', async (ctx) => {
    const memories = getMemories(String(ctx.chat.id), {
      limit: 10,
      orderBy: 'accessed_at DESC',
    });
    if (memories.length === 0) {
      await ctx.reply('No memories stored yet.');
      return;
    }
    const lines = memories.map(
      (m, i) =>
        `${i + 1}. <b>${new Date(m.created_at).toLocaleDateString()}</b>: ${escapeHtml(m.content.slice(0, 120))}`,
    );
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('voice', async (ctx) => {
    const chatId = ctx.chat.id;
    const caps = voiceCapabilities();
    if (!caps.stt) {
      await ctx.reply(
        'Voice mode unavailable: GROQ_API_KEY not configured.',
      );
      return;
    }
    if (voiceModeChats.has(chatId)) {
      voiceModeChats.delete(chatId);
      await ctx.reply('Voice mode disabled.');
    } else {
      voiceModeChats.add(chatId);
      await ctx.reply(
        'Voice mode enabled. Send voice messages and I\'ll transcribe them.',
      );
    }
  });

  bot.command('schedule', async (ctx) => {
    await handleScheduleCommand(bot, ctx);
  });

  // --- Message handlers ---

  // Text messages
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!isAuthorised(chatId)) {
      logger.warn({ chatId }, 'Unauthorised message attempt');
      return;
    }

    const text = ctx.message.text;
    // Skip if it's a command (already handled above)
    if (text.startsWith('/')) return;

    await handleMessage(bot, chatId, text, ctx.from?.username);
  });

  // Voice messages
  bot.on('message:voice', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!isAuthorised(chatId)) return;

    const caps = voiceCapabilities();
    if (!caps.stt) {
      await ctx.reply('Voice transcription unavailable: GROQ_API_KEY not set.');
      return;
    }

    try {
      const fileId = ctx.message.voice.file_id;
      const localPath = await downloadMedia(fileId, 'voice-note');

      const transcription = await transcribeAudio(localPath);
      logger.info({ chatId, transcription: transcription.slice(0, 80) }, 'Voice transcribed');

      // Send transcription preview
      await ctx.reply(`[Voice transcribed]: ${transcription.slice(0, 200)}${transcription.length > 200 ? '...' : ''}`);

      // Process as a regular message
      await handleMessage(
        bot,
        chatId,
        `[Voice transcribed]: ${transcription}`,
        ctx.from?.username,
      );
    } catch (err: any) {
      logger.error({ err: err.message, chatId }, 'Voice processing failed');
      await ctx.reply(`Voice processing failed: ${err.message}`);
    }
  });

  // Photos
  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!isAuthorised(chatId)) return;

    try {
      // Get the highest resolution photo (last in the array)
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const localPath = await downloadMedia(largest.file_id, 'photo');
      const caption = ctx.message.caption;

      const prompt = buildPhotoMessage(localPath, caption);
      await handleMessage(bot, chatId, prompt, ctx.from?.username);
    } catch (err: any) {
      logger.error({ err: err.message, chatId }, 'Photo processing failed');
      await ctx.reply(`Photo processing failed: ${err.message}`);
    }
  });

  // Documents
  bot.on('message:document', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!isAuthorised(chatId)) return;

    try {
      const doc = ctx.message.document;
      const localPath = await downloadMedia(doc.file_id, doc.file_name);
      const caption = ctx.message.caption;

      const prompt = buildDocumentMessage(
        localPath,
        doc.file_name || 'unknown',
        caption,
      );
      await handleMessage(bot, chatId, prompt, ctx.from?.username);
    } catch (err: any) {
      logger.error({ err: err.message, chatId }, 'Document processing failed');
      await ctx.reply(`Document processing failed: ${err.message}`);
    }
  });

  // Video
  bot.on('message:video', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!isAuthorised(chatId)) return;

    try {
      const video = ctx.message.video;
      const localPath = await downloadMedia(video.file_id, 'video');
      const caption = ctx.message.caption;

      const prompt = buildVideoMessage(localPath, caption);
      await handleMessage(bot, chatId, prompt, ctx.from?.username);
    } catch (err: any) {
      logger.error({ err: err.message, chatId }, 'Video processing failed');
      await ctx.reply(`Video processing failed: ${err.message}`);
    }
  });

  // --- Error handler ---
  bot.catch((err) => {
    logger.error({ err: err.message }, 'Bot error');
  });

  // --- Initialize scheduler ---
  initScheduler(async (chatId: string, text: string) => {
    await safeSend(bot, chatId, text);
  });

  // --- Periodic cleanup of old uploads (every 6 hours) ---
  setInterval(() => cleanupOldUploads(), 6 * 60 * 60 * 1000);

  return bot;
}
