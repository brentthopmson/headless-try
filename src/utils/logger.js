import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'engine.log');

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
        console.log(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
        writeToFile('INFO', message, ...args);
    },
    error: (message, error) => {
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, '\nError:', error);
        writeToFile('ERROR', message, error);
    },
    warn: (message, ...args) => {
        console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, ...args);
        writeToFile('WARN', message, ...args);
    },
    debug: (message, ...args) => {
        console.debug(`[DEBUG] ${new Date().toISOString()} - ${message}`, ...args);
        writeToFile('DEBUG', message, ...args);
    }
};

export default logger;
