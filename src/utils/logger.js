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
// E-h: truncate only ONCE per process. Next dev re-evaluates this module on HMR
// compiles (e.g. when another route finishes compiling), and wiping engine.log
// mid-run destroyed the forensic history needed to diagnose the duplicate-launch
// race. A real restart still wipes because the global flag dies with the process.
if (isDev && !globalThis.__engineLogTruncated) {
    globalThis.__engineLogTruncated = true;
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

// --- Async file write (production too, so visible/headless runs are inspectable) ---
const MAX_LOG_BYTES = 20 * 1024 * 1024;

function ensureLogDir() {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function rotateIfNeeded(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size <= MAX_LOG_BYTES) return;
        try { fs.copyFileSync(filePath, `${filePath}.1`); } catch {}
        fs.writeFileSync(filePath, `[log rotated] ${new Date().toISOString()}\n`, 'utf-8');
    } catch {}
}

async function appendToFile(filePath, line) {
    try {
        ensureLogDir();
        rotateIfNeeded(filePath);
        await fs.promises.appendFile(filePath, line, 'utf-8');
    } catch {}
}

// One process-start marker in both dev and production (no truncation in prod).
if (!globalThis.__engineLogStarted) {
    globalThis.__engineLogStarted = true;
    appendToFile(LOG_FILE, `[engine start] ${new Date().toISOString()} pid=${process.pid} mode=${isProduction ? 'production' : 'dev'}\n`);
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
    if (!campaignId) return;
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
            if (!shouldLog(level.toLowerCase())) return;
            const tagged = tag ? `${tag} ${message}` : message;
            // Console
            const consoleFn = { INFO: console.log, WARN: console.warn, ERROR: console.error, DEBUG: console.debug }[level];
            if (consoleFn) {
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
