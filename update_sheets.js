import { getSheetDataApi } from './src/app/api/googlesheets.js';
import { google } from 'googleapis';
import logger from './src/utils/logger.js';

// Try to use direct API
const { getSheetsAuthClient } = await import('./src/app/api/googlesheets.js');
const { SPREADSHEET_ID } = await import('./src/app/api/googlesheets.js');
