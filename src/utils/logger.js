import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'engine.log');
const LOG_DIR = path.join(process.cwd(), 'logs');
const isProduction = process.env.NODE_ENV === 'production';
const isDev = !isProduction;

const LOG_LEVEL = (process.env.LOG_LEVEL || (isProduction ? 'warn' : 'info')).toLowerCase();
const LEVEL_PRIORITY = { error: 0, warn: 1, info: 2, debug: 3 };
const currentPriority = LEVEL_PRIORITY[LOG_LEVEL] ?? 2;

function shouldLog(level) {
    return (LEVEL_PRIORITY[level] ?? 2) <= currentPriority;
}

// --- Dev-only: clear logs on server restart ---
if (isDev) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        // Truncate engine.log
        if (fs.existsSync(LOG_FILE)) fs.truncateSync(LOG_FILE, 0);
        // Clear per-campaign log files
        const files = fs.readdirSync(LOG_DIR);
        for (const f of files) {
            if (f.startsWith('campaign-') && f.endsWith('.log')) {
                fs.unlinkSync(path.join(LOG_DIR, f));
            }
        }
    } catch {}
}

// --- Async file write (dev only) ---
async function appendToFile(filePath, line) {
    if (!isDev) return;
    try { await fs.promises.appendFile(filePath, line, 'utf-8'); } catch {}
}

function formatLine(level, message, args) {
    const timestamp = new Date().toISOString();
    const extras = args.length > 0
        ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
        : '';
    return `[${level}] ${timestamp} - ${message}${extras}\n`;
}

function logToEngine(level, message, args) {
    const line = formatLine(level, message, args);
    appendToFile(LOG_FILE, line);
}

function logToCampaign(campaignId, level, message, args) {
    if (!campaignId || !isDev) return;
    const line = formatLine(level, message, args);
    const campaignFile = path.join(LOG_DIR, `campaign-${campaignId}.log`);
    appendToFile(campaignFile, line);
}

// --- Core logger ---
const logger = {
    infoEnabled: () => shouldLog('info'),

    info(message, ...args) {
        if (!shouldLog('info')) return;
        console.log(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
        logToEngine('INFO', message, args);
    },

    error(message, error) {
        if (!shouldLog('error')) return;
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, '\nError:', error);
        logToEngine('ERROR', message, [error]);
    },

    warn(message, ...args) {
        if (!shouldLog('warn')) return;
        console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, ...args);
        logToEngine('WARN', message, args);
    },

    debug(message, ...args) {
        if (!shouldLog('debug')) return;
        console.debug(`[DEBUG] ${new Date().toISOString()} - ${message}`, ...args);
        logToEngine('DEBUG', message, args);
    },

    // --- Scoped logger: writes to engine.log + logs/campaign-{id}.log ---
    child({ campaignId, stage }) {
        const tag = stage ? `[${stage}]` : '';
        const log = (level, message, args) => {
            const tagged = tag ? `${tag} ${message}` : message;
            // Console
            const consoleFn = { INFO: console.log, WARN: console.warn, ERROR: console.error, DEBUG: console.debug }[level];
            if (consoleFn && shouldLog(level.toLowerCase())) {
                consoleFn(`[${level}] ${new Date().toISOString()} - ${tagged}`, ...args);
            }
            // Engine log
            logToEngine(level, tagged, args);
            // Campaign-specific log
            logToCampaign(campaignId, level, tagged, args);
        };

        return {
            info: (msg, ...a) => log('INFO', msg, a),
            warn: (msg, ...a) => log('WARN', msg, a),
            error: (msg, e) => log('ERROR', msg, [e]),
            debug: (msg, ...a) => log('DEBUG', msg, a),
        };
    },

    // --- Timer helper ---
    timer(label) {
        const start = Date.now();
        return {
            end(extraMsg) {
                const elapsed = ((Date.now() - start) / 1000).toFixed(1);
                const msg = extraMsg ? `${label} completed in ${elapsed}s — ${extraMsg}` : `${label} completed in ${elapsed}s`;
                logger.info(msg);
            }
        };
    }
};

export default logger;
