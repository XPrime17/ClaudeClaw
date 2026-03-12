import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readEnvFile } from './env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the project root directory. */
export const PROJECT_ROOT = join(__dirname, '..', '..');

/** Working directory for spawned Claude agent instances. */
export const AGENT_CWD = PROJECT_ROOT;

/** Directory for persistent storage (SQLite, files, etc). */
export const STORE_DIR = join(PROJECT_ROOT, 'store');

// ---------------------------------------------------------------------------
// Read .env once at import time — never pollutes process.env
// ---------------------------------------------------------------------------
const env = readEnvFile();

/** Telegram bot token (from BotFather). */
export const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN ?? '';

/** Comma-separated chat IDs that are allowed to interact with the bot. */
export const ALLOWED_CHAT_ID = env.ALLOWED_CHAT_ID ?? '';

/** Groq API key for speech-to-text (Whisper). */
export const GROQ_API_KEY = env.GROQ_API_KEY ?? '';

/** Google API key (Gemini, etc). */
export const GOOGLE_API_KEY = env.GOOGLE_API_KEY ?? '';

/** ElevenLabs API key for text-to-speech. */
export const ELEVENLABS_API_KEY = env.ELEVENLABS_API_KEY ?? '';

/** ElevenLabs voice ID for TTS output. */
export const ELEVENLABS_VOICE_ID = env.ELEVENLABS_VOICE_ID ?? '';

// ---------------------------------------------------------------------------
// Application constants
// ---------------------------------------------------------------------------

/** Telegram maximum message length. */
export const MAX_MESSAGE_LENGTH = 4096;

/** Interval (ms) to re-send "typing" action so Telegram keeps the indicator. */
export const TYPING_REFRESH_MS = 4000;

/** Default Claude model to use. */
export const MODEL = 'sonnet';

// ---------------------------------------------------------------------------
// Ensure required directories exist at import time
// ---------------------------------------------------------------------------
mkdirSync(STORE_DIR, { recursive: true });
mkdirSync(join(PROJECT_ROOT, 'workspace', 'uploads'), { recursive: true });
