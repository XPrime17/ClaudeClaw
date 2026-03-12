import { readFileSync, renameSync } from 'fs';
import { basename } from 'path';
import { GROQ_API_KEY } from './config.js';
import { logger } from './logger.js';

/**
 * Report which voice capabilities are available based on configured API keys.
 */
export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return { stt: !!GROQ_API_KEY, tts: false };
}

/**
 * Transcribe an audio file using Groq's Whisper Large V3 endpoint.
 *
 * Telegram delivers voice notes as .oga (Ogg/Opus). Groq's API only accepts
 * .ogg — the container format is identical so a rename is sufficient.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

  // Rename .oga → .ogg (Groq requirement — same format, different extension)
  let actualPath = filePath;
  if (filePath.endsWith('.oga')) {
    actualPath = filePath.replace(/\.oga$/, '.ogg');
    renameSync(filePath, actualPath);
  }

  const fileBuffer = readFileSync(actualPath);
  const filename = basename(actualPath);

  // Build multipart form-data manually (no extra deps)
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];

  // File part
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n'));

  // Model part
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`
  ));

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    logger.error({ status: response.status, body: errText }, 'Groq transcription failed');
    throw new Error(`Groq STT failed: ${response.status}`);
  }

  const data = await response.json() as { text: string };
  logger.info({ chars: data.text.length }, 'Transcription complete');
  return data.text;
}
