// audit/logger.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.jsonl');

// Ensure logs/ exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

export function writeAuditEntry(action, details, level = 'info') {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    ...details,
  };

  // Console (you'll see it in your main log stream)
  console.log(`[AUDIT] [${action}]`, JSON.stringify(details));

  // Append to JSONL file
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[AUDIT] File write error:', err.message);
  }

  // Optionally feed into your existing structured logger (Winston, etc.)
  // if (global.logger) global.logger.log(level, `[AUDIT] ${action}`, details);
}
