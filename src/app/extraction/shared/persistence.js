import axios from 'axios';
import logger from '../../../utils/logger.js';
import { updateSheetRowApi, ensureSheetColumns } from '../../api/googlesheets.js';
import { HUB_SHEET } from './constants.js';

async function writeHubViaAppScript(browserId, dataMap) {
    const appScriptUrl = process.env.SCRIPT_URL;
    const appScriptKey = process.env.SCRIPT_KEY;
    if (!appScriptUrl || !appScriptKey) {
        return { success: false, error: 'SCRIPT_URL or SCRIPT_KEY not configured' };
    }
    try {
        // Raw JSON body: urlencoded POSTs above ~50KB hit Apps Script's
        // redirect/parameter size limit and come back as an HTML page instead
        // of JSON (doPost merges e.postData.contents into params).
        const resp = await axios.post(appScriptUrl, {
            action: 'setMultipleCellDataByColumnSearch',
            sheetName: HUB_SHEET,
            searchColumn: 'submissionId',
            searchValue: browserId,
            key: appScriptKey,
            data: dataMap,
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000,
        });
        const body = typeof resp.data === 'string' ? null : resp.data;
        if (body?.success) {
            return { success: true };
        }
        if (!body) {
            return { success: false, error: 'App Script returned non-JSON response (payload likely over size limit)' };
        }
        return { success: false, error: body.error || 'App Script returned success=false' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Save a full extract JSON to Drive through the Apps Script (DriveApp uses the
// script's own authorization — unaffected by the engine's expired OAuth token).
// Apps Script web-app POSTs above ~50KB return an HTML page, so the minified JSON
// is uploaded in sequential <=32KB chunks; the handler appends part 0..n-1 and
// the final part returns the fileId.
async function saveExtractViaAppScript(browserId, column, data) {
    const appScriptUrl = process.env.SCRIPT_URL;
    const appScriptKey = process.env.SCRIPT_KEY;
    if (!appScriptUrl || !appScriptKey) {
        return { success: false, error: 'SCRIPT_URL or SCRIPT_KEY not configured' };
    }
    try {
        const json = JSON.stringify(data);
        const CHUNK = 32000;
        const parts = [];
        for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
        const fileName = `${column}.json`;
        let last = null;
        for (let i = 0; i < parts.length; i++) {
            const resp = await axios.post(appScriptUrl, {
                action: 'saveExtractToDrive',
                key: appScriptKey,
                browserId,
                fileName,
                chunk: parts[i],
                partIndex: i,
                totalParts: parts.length,
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 120000,
            });
            const body = typeof resp.data === 'string' ? null : resp.data;
            if (!body?.success) {
                return { success: false, error: body ? (body.error || `part ${i + 1}/${parts.length} failed`) : `non-JSON response at part ${i + 1}/${parts.length}` };
            }
            last = body;
        }
        return { success: true, fileId: last.fileId, fileName: last.fileName || fileName, size: last.size || json.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Last-resort cell payload: keep summaries but strip contact subjects/bodies and
// shed contacts until the JSON fits under the transport-safe cell budget.
function compactExtractForCell(data) {
    try {
        const base = { ...data };
        delete base.financialMentions;
        const minimal = c => ({ name: c.name, email: c.email, type: c.type, source: c.source });
        const all = (data.contacts || []).map(minimal);
        base.contacts = all;
        let s = JSON.stringify(base);
        let limit = all.length;
        while (s.length > 34000 && limit > 1) {
            limit = Math.max(1, Math.floor(limit * 0.75));
            base.contacts = all.slice(0, limit);
            s = JSON.stringify(base);
        }
        return s;
    } catch (e) {
        return JSON.stringify(data);
    }
}

// ==================== Orchestrator ====================

async function updateExtractStatus(browserId, status) {
    const statusMap = {
        extractStatus: status,
        extractStatusAt: new Date().toISOString(),
    };
    try {
        await ensureSheetColumns(HUB_SHEET, ['submissionId', 'extractStatus', 'extractStatusAt']);
        const r = await updateSheetRowApi(HUB_SHEET, 'submissionId', browserId, statusMap);
        if (r && r.success) return;
        throw new Error(r?.error || 'sheets write failed');
    } catch (e) {
        const as = await writeHubViaAppScript(browserId, statusMap);
        if (!as.success) {
            logger.warn(`[smartExtract] status update failed: ${e.message}; app script fallback: ${as.error}`);
        }
    }
}

const EXTRACT_COLUMN = {
    wire: 'wireExtract',
    social: 'socialExtract',
    bank: 'bankExtract',
};

// True only when the extract carries content worth persisting. A zero-count
// run (dead session → sign-in redirects before any data was collected, or
// selectors missed everything) looks like a valid object/array but must NEVER
// overwrite the last good extract in the hub cell / Drive JSON.
function extractionHasUpdates(data) {
    if (data == null) return false;
    if (Array.isArray(data)) {
        // social: [account] with extractedDetails; bank: accounts[] (a failed
        // bank run returns a single balance=0/transactions=[] fallback shell).
        return data.some((x) => {
            if (!x || typeof x !== 'object') return false;
            if ((x.transactions || []).length > 0) return true;
            if (Number(x.balance || 0) > 0) return true;
            const d = x.extractedDetails;
            if (d && ((d.followers || []).length > 0 || (d.recentActivity || []).length > 0 || Number(d.followersCount || 0) > 0)) return true;
            return false;
        });
    }
    if (typeof data !== 'object') return false;
    if ((data.contacts || []).length > 0) return true;
    if ((data.activities || []).length > 0) return true;
    const box = data.boxSummary || {};
    if (Number(box.totalEmails || 0) > 0 || Number(box.unreadEmails || 0) > 0 || (box.folders || []).length > 0) return true;
    if (Number(data.averageTransactionAmount || 0) > 0 || Number(data.highestTransactionAmount || 0) > 0) return true;
    if (data.lastTransactionDate || data.mailboxProfile) return true;
    return false;
}

export {
    writeHubViaAppScript,
    saveExtractViaAppScript,
    compactExtractForCell,
    updateExtractStatus,
    EXTRACT_COLUMN,
    extractionHasUpdates,
};
