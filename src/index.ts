import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT, STORE_DIR, TELEGRAM_BOT_TOKEN } from './config.js';
import { initDatabase } from './db.js';
import { logger } from './logger.js';
import { runDecaySweep } from './memory.js';
import { cleanupOldUploads } from './media.js';
import { createBot } from './bot.js';
import { initScheduler, stopScheduler } from './scheduler.js';

const PID_FILE = join(STORE_DIR, 'claudeclaw.pid');

function acquireLock(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(oldPid, 0); // Check if alive
      logger.warn({ oldPid }, 'Killing stale instance');
      process.kill(oldPid, 'SIGTERM');
    } catch {
      // Process already dead, ignore
    }
  }
  writeFileSync(PID_FILE, process.pid.toString());
}

function releaseLock(): void {
  try { unlinkSync(PID_FILE); } catch {}
}

async function main(): Promise<void> {
  // Banner
  console.log(`
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
`);

  // Check required config
  if (!TELEGRAM_BOT_TOKEN) {
    logger.fatal('TELEGRAM_BOT_TOKEN not set. Run: npm run setup');
    process.exit(1);
  }

  // Acquire PID lock
  acquireLock();

  // Initialize database
  initDatabase();
  logger.info('Database initialized');

  // Run memory decay sweep + schedule daily
  runDecaySweep();
  setInterval(runDecaySweep, 24 * 60 * 60 * 1000);

  // Clean up old uploads
  cleanupOldUploads();

  // Create and start bot
  const bot = createBot();

  // Initialize scheduler
  const sendFn = async (chatId: string, text: string) => {
    await bot.api.sendMessage(chatId, text);
  };
  initScheduler(sendFn);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    stopScheduler();
    bot.stop();
    releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start bot
  try {
    await bot.start({
      onStart: () => logger.info('ClaudeClaw is running'),
    });
  } catch (err: any) {
    logger.fatal({ err: err.message }, 'Failed to start bot -- check TELEGRAM_BOT_TOKEN');
    releaseLock();
    process.exit(1);
  }
}

main().catch(err => {
  logger.fatal({ err: err.message }, 'Fatal error');
  process.exit(1);
});
