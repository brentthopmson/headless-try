const logger = {
    info: (message, ...args) => {
        console.log(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
    },
    error: (message, error) => {
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, '\nError:', error);
    },
    warn: (message, ...args) => {
        console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, ...args);
    },
    debug: (message, ...args) => {
        console.debug(`[DEBUG] ${new Date().toISOString()} - ${message}`, ...args);
    }
};

export default logger;