/**
 * WhatsApp bridge using whatsapp-web.js.
 *
 * Provides incoming message handling and outgoing send capability.
 * Auth persists via LocalAuth strategy so QR scan is only needed once.
 */

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import { logger } from './logger.js';
import { saveWaMessage, getWaMessages } from './db.js';

type IncomingHandler = (message: {
  chatJid: string;
  sender: string;
  body: string;
  timestamp: number;
}) => void | Promise<void>;

let client: InstanceType<typeof Client> | null = null;

/**
 * Initialize the WhatsApp Web client.
 *
 * @param onIncoming - callback fired for every incoming message
 */
export function initWhatsApp(onIncoming: IncomingHandler): void {
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr: string) => {
    logger.info('WhatsApp QR code generated — scan with your phone:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    logger.info('WhatsApp Web client connected');
  });

  client.on('authenticated', () => {
    logger.info('WhatsApp authenticated');
  });

  client.on('auth_failure', (msg: string) => {
    logger.error({ msg }, 'WhatsApp authentication failed');
  });

  client.on('disconnected', (reason: string) => {
    logger.warn({ reason }, 'WhatsApp disconnected');
  });

  client.on('message', async (msg: any) => {
    const chatJid = msg.from;
    const sender = msg._data?.notifyName || msg.from;
    const body = msg.body || '';
    const timestamp = msg.timestamp || Math.floor(Date.now() / 1000);

    // Persist to DB
    try {
      saveWaMessage({
        chatJid,
        sender,
        content: body,
        isIncoming: true,
      });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to save WA message to DB');
    }

    // Fire callback
    try {
      await onIncoming({ chatJid, sender, body, timestamp });
    } catch (err: any) {
      logger.error({ err: err.message, chatJid }, 'WA incoming handler error');
    }
  });

  client.initialize();
  logger.info('WhatsApp Web client initializing...');
}

/**
 * Send a text message to a WhatsApp chat.
 */
export async function sendWaMessage(
  chatJid: string,
  content: string,
): Promise<void> {
  if (!client) throw new Error('WhatsApp client not initialized');

  await client.sendMessage(chatJid, content);

  // Persist outgoing message
  try {
    saveWaMessage({
      chatJid,
      sender: 'bot',
      content,
      isIncoming: false,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to save outgoing WA message');
  }

  logger.info({ chatJid, chars: content.length }, 'WA message sent');
}

/**
 * Get recent WhatsApp chats with last message preview.
 *
 * Note: This returns an empty array until a getRecentWaChats query is added
 * to db.ts. For now, the /wa command in the bot can list messages per chat
 * using listWaMessages() instead.
 */
export function getRecentWaChats(_limit: number = 20): any[] {
  // TODO: Add a getRecentWaChats() query to db.ts that does:
  //   SELECT chat_jid, MAX(created_at) as last_msg_at, COUNT(*) as msg_count
  //   FROM wa_messages GROUP BY chat_jid ORDER BY last_msg_at DESC LIMIT ?
  logger.warn('getRecentWaChats: not yet implemented in db.ts');
  return [];
}

/**
 * List messages for a specific WhatsApp chat.
 */
export function listWaMessages(chatJid: string, limit: number = 50): any[] {
  return getWaMessages(chatJid, limit);
}
