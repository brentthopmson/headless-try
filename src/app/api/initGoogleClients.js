import { initializeGoogleSheets } from './googlesheets.js';
import { initializeGoogleDrive } from './googledrive.mjs';
import logger from '../../utils/logger.js';

async function initGoogleClients() {
  logger.debug('Starting Google API client initialization...');
  try {
    await initializeGoogleSheets();
    await initializeGoogleDrive();
    logger.debug('Google API clients initialized successfully.');
  } catch (error) {
    logger.error(`Failed to initialize Google API clients: ${error.message}`);
  }
}

// Execute initialization when this module is imported
initGoogleClients();
