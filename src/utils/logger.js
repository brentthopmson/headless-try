import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'engine.log');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const LEVEL_PRIORITY = { error: 0, warn: 1, info: 2, debug: 3 };
const currentPriority = LEVEL_PRIORITY[LOG_LEVEL] ?? 2;

function shouldLog(level) {
    return (LEVEL_PRIORITY[level] ?? 2) <= currentPriority;
}

function writeToFile(level, message, ...args) {
    try {
        const timestamp = new Date().toISOString();
        const extras = args.length > 0 ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') : '';
        const line = `[${level}] ${timestamp} - ${message}${extras}\n`;
        fs.appendFileSync(LOG_FILE, line, 'utf-8');
    } catch (e) {
        // silently fail if file write fails
    }
}

const logger = {
    info: (message, ...args) => {
        if (!shouldLog('info')) return;
        console.log(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
        writeToFile('INFO', message, ...args);
    },
    error: (message, error) => {
        if (!shouldLog('error')) return;
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, '\nError:', error);
        writeToFile('ERROR', message, error);
    },
    warn: (message, ...args) => {
        if (!shouldLog('warn')) return;
        console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, ...args);
        writeToFile('WARN', message, ...args);
    },
    debug: (message, ...args) => {
        if (!shouldLog('debug')) return;
        console.debug(`[DEBUG] ${new Date().toISOString()} - ${message}`, ...args);
        writeToFile('DEBUG', message, ...args);
    }
};

export default logger;
