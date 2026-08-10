import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.jsonl');

// Ensure logs directory exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

export function writeAuditEntry(action, details, level = 'info') {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    ...details,
  };

  // Console output (visible in your standard logs)
  const detailStr = JSON.stringify(details);
  console.log(`[AUDIT] [${action}] ${detailStr}`);

  // Append to JSONL file
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[AUDIT] Failed to write to audit file:', err.message);
  }

  // If you use a custom logger, you can integrate it here:
  // global.logger?.log(level, `[AUDIT] ${action}`, details);
}
