import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const ENV_FILE = join(PROJECT_ROOT, '.env');
const DB_FILE = join(PROJECT_ROOT, 'store', 'claudeclaw.db');

// ANSI colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const pass = (label: string, detail?: string) =>
  console.log(`  ${green('[ok]')} ${label}${detail ? dim(` -- ${detail}`) : ''}`);
const warn = (label: string, detail?: string) =>
  console.log(`  ${yellow('[!!]')} ${label}${detail ? dim(` -- ${detail}`) : ''}`);
const fail = (label: string, detail?: string) =>
  console.log(`  ${red('[xx]')} ${label}${detail ? dim(` -- ${detail}`) : ''}`);

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(ENV_FILE)) return env;

  const content = readFileSync(ENV_FILE, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (value) env[key] = value;
  }
  return env;
}

function checkNode(): void {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major >= 20) {
    pass('Node.js', version);
  } else {
    fail('Node.js', `${version} (need >= 20)`);
  }
}

function checkClaude(): void {
  const which = spawnSync('which', ['claude'], { encoding: 'utf-8' });
  if (which.status !== 0) {
    fail('Claude CLI', 'not found');
    return;
  }

  const ver = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 });
  if (ver.status === 0) {
    pass('Claude CLI', ver.stdout.trim().split('\n')[0]);
  } else {
    warn('Claude CLI', 'found but version check failed');
  }
}

function checkEnvKeys(env: Record<string, string>): void {
  if (env.TELEGRAM_BOT_TOKEN) {
    const masked = env.TELEGRAM_BOT_TOKEN.slice(0, 8) + '...' + env.TELEGRAM_BOT_TOKEN.slice(-4);
    pass('Bot Token', masked);
  } else {
    fail('Bot Token', 'not set');
  }

  if (env.ALLOWED_CHAT_ID) {
    pass('Chat ID', env.ALLOWED_CHAT_ID);
  } else {
    warn('Chat ID', 'not set -- send /chatid to the bot');
  }

  if (env.GROQ_API_KEY) {
    pass('Groq API Key', 'configured');
  } else {
    warn('Groq API Key', 'not set -- voice notes disabled');
  }

  if (env.GOOGLE_API_KEY) {
    pass('Google API Key', 'configured');
  } else {
    warn('Google API Key', 'not set -- video analysis disabled');
  }
}

function checkSystemd(): void {
  const result = spawnSync(
    'systemctl',
    ['--user', 'is-active', 'claudeclaw.service'],
    { encoding: 'utf-8' }
  );
  const status = result.stdout.trim();

  if (status === 'active') {
    pass('Systemd Service', 'active (running)');
  } else if (status === 'inactive') {
    warn('Systemd Service', 'inactive (not running)');
  } else if (status === 'failed') {
    fail('Systemd Service', 'failed -- check: journalctl --user -u claudeclaw -n 20');
  } else {
    warn('Systemd Service', `${status || 'not installed'}`);
  }
}

function checkDatabase(): void {
  if (!existsSync(DB_FILE)) {
    warn('Database', 'not yet created (starts on first run)');
    return;
  }

  try {
    const db = new Database(DB_FILE, { readonly: true });

    const tables: Array<{ name: string }> = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name).filter(n => !n.startsWith('sqlite_'));
    pass('Database', DB_FILE);

    for (const name of tableNames) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as count FROM "${name}"`).get() as { count: number };
        console.log(`         ${dim(name)}: ${row.count} rows`);
      } catch {
        console.log(`         ${dim(name)}: (error reading)`);
      }
    }

    db.close();
  } catch (err: any) {
    fail('Database', err.message);
  }
}

function main(): void {
  console.log(bold('\n  ClaudeClaw Status\n'));

  const env = loadEnv();

  console.log(bold('  Runtime'));
  checkNode();
  checkClaude();

  console.log(bold('\n  Configuration'));
  if (existsSync(ENV_FILE)) {
    pass('.env file', ENV_FILE);
  } else {
    fail('.env file', 'not found -- run: npm run setup');
  }
  checkEnvKeys(env);

  console.log(bold('\n  Service'));
  checkSystemd();

  console.log(bold('\n  Storage'));
  checkDatabase();

  console.log('');
}

main();
