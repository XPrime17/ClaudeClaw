import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TELEGRAM_BOT_TOKEN } from './config.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = join(__dirname, '..', 'workspace', 'uploads');

// Ensure uploads dir exists
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Download a file from Telegram by file_id
// ---------------------------------------------------------------------------

export async function downloadMedia(
  fileId: string,
  originalFilename?: string,
): Promise<string> {
  // Step 1 — resolve the file_id to a server-side path via Telegram API
  const fileRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    },
  );
  const fileData = (await fileRes.json()) as any;
  if (!fileData.ok || !fileData.result?.file_path) {
    throw new Error('Failed to get file path from Telegram');
  }

  // Step 2 — download the actual bytes
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);

  const buffer = Buffer.from(await dlRes.arrayBuffer());

  // Step 3 — write to local workspace/uploads with a safe filename
  const ext = fileData.result.file_path.split('.').pop() || 'bin';
  const safeName = (originalFilename || `file-${Date.now()}`).replace(
    /[^a-zA-Z0-9._-]/g,
    '-',
  );
  const localPath = join(UPLOADS_DIR, `${Date.now()}_${safeName}.${ext}`);

  writeFileSync(localPath, buffer);
  logger.info({ path: localPath, bytes: buffer.length }, 'Media downloaded');
  return localPath;
}

// ---------------------------------------------------------------------------
// Build context prompts for different media types
// ---------------------------------------------------------------------------

export function buildPhotoMessage(
  localPath: string,
  caption?: string,
): string {
  const captionPart = caption ? ` with caption: "${caption}"` : '';
  return `[The user sent a photo${captionPart}. The image has been saved to ${localPath}. Use the Read tool to view the image, then respond about what you see. If it looks like food, offer to log it as a meal.]`;
}

export function buildDocumentMessage(
  localPath: string,
  filename: string,
  caption?: string,
): string {
  const captionPart = caption ? ` with caption: "${caption}"` : '';
  return `[The user sent a document "${filename}"${captionPart}. It has been saved to ${localPath}. Read and analyze the file, then respond with key findings.]`;
}

export function buildVideoMessage(
  localPath: string,
  caption?: string,
): string {
  const captionPart = caption ? ` with caption: "${caption}"` : '';
  return `[The user sent a video${captionPart}. It has been saved to ${localPath}. Use the Gemini API with the GOOGLE_API_KEY from .env to analyze this video. Respond with a description and key observations.]`;
}

// ---------------------------------------------------------------------------
// Housekeeping — delete uploads older than maxAgeMs (default 24 h)
// ---------------------------------------------------------------------------

export function cleanupOldUploads(
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): void {
  if (!existsSync(UPLOADS_DIR)) return;
  const now = Date.now();
  let cleaned = 0;
  for (const file of readdirSync(UPLOADS_DIR)) {
    const filePath = join(UPLOADS_DIR, file);
    try {
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filePath);
        cleaned++;
      }
    } catch {
      // ignore individual file errors
    }
  }
  if (cleaned > 0) logger.info({ cleaned }, 'Old uploads cleaned');
}
