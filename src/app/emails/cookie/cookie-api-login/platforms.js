import logger from "../../../../utils/logger.js"; // Added import for logger

export const platformConfigs = {
    gmail: {
        inboxUrlPatterns: [
            /mail\.google\.com\//
        ],
        inboxDomSelectors: [
        ],
        url: "https://gmail.com/",
        mxKeywords: ['google', 'gmail'],
        selectors: {
            input: "#identifierId",
            nextButton: "#identifierNext",
            passwordInput: ["input[name='Passwd']", "input[type='password']"],
            passwordNextButton: "#passwordNext",
            errorMessage: "//*[contains(text(), \"Couldn't find your Google Account\") or contains(text(), \"Enter an email\") or contains(text(), \"Enter a valid email\") or contains(text(), \"Couldn’t find your Google Account\")]", // Add more as needed
            loginFailed: "//*[contains(., 'Wrong password') or contains(., 'Your password was changed') or contains(., \"Couldn't sign you in\")]",
            verificationCodeInput: "input[type='tel'][name='ca']",
            verificationCodeSubmit: "#idvPreregisteredPhoneNext",
            gmailEmailCodeInput: "#idvPinId",
            gmailEmailCodeSubmit: "#idvpreregisteredemailNext",
            recoveryEmailInput: "#knowledge-preregistered-email-response",
            recoveryEmailNext: "#knowledge-preregistered-email-next"
        },
        captchaConfig: {
            urlPatterns: [/\/challenge\/recaptcha/, /\/signin\/challenge\//],
            answerInput: "input[name='ca'], input#ca, input[name='captcha']",
            submitButton: "#confirm, button[jsname='LgbsSe']",
            screenshotArea: "[jsname='rvuZqe'], form"
        },
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            const instanceId = `gmail-${page.browser().process()?.pid || 'unknown'}`;
            if (viewName === 'Gmail Verification Choices') {
                try {
                    await page.waitForSelector('ul.Dl08I', { timeout: 5000 });
                    const options = await page.evaluate(() => {
                        const listItems = document.querySelectorAll('ul.Dl08I li.aZvCDf');
                        const extracted = [];
                        listItems.forEach((li, index) => {
                            const link = li.querySelector('.VV3oRb');
                            if (link && !li.hasAttribute('aria-disabled')) {
                                const text = link.textContent.trim();
                                const challengeType = link.getAttribute('data-challengetype');
                                const actionType = link.getAttribute('data-action');
                                const isAccountRecovery = link.getAttribute('data-accountrecovery') === 'true';
                                let optionType = 'unknown';
                                if (isAccountRecovery) {
                                    optionType = 'account_recovery';
                                } else if (challengeType === '39') {
                                    optionType = 'tap_yes';
                                } else if (challengeType === '9') {
                                    optionType = 'sms';
                                } else if (challengeType === '30') {
                                    optionType = 'email_code';
                                } else if (challengeType === '42') {
                                    optionType = 'device_approval';
                                } else if (challengeType === '12') {
                                    optionType = 'recovery_email';
                                }
                                const requiresInput = (challengeType === '9' && text.includes('verification code'));
                                extracted.push({
                                    label: text,
                                    choiceIndex: (index + 1).toString(),
                                    type: optionType,
                                    requiresInput: requiresInput,
                                    inputSelector: requiresInput ? '#iProofPhone' : null,
                                    inputLabel: requiresInput ? 'Last 4 digits' : null
                                });
                            }
                        });
                        return extracted;
                    });
                    logger.debug(`[Gmail][${instanceId}] Extracted ${options.length} options for 'Gmail Verification Choices'`);
                    return options;
                } catch (error) {
                    logger.error(`[Gmail][${instanceId}] Error extracting options: ${error.message}`);
                    return [];
                }
            }
            return [];
        },
        additionalViews: [
            {
                name: 'Gmail Recovery Info Setup',
                match: {
                    selector: ['*'],
                    text: 'Make sure you can always sign in'
                },
                action: {
                    type: 'click',
                    selector: ['button[aria-label="Save"]', 'button::-p-text("Save")', 'button[aria-label="Cancel"]', 'button::-p-text("Cancel")'],
                    navigationWaitUntil: 'domcontentloaded'
                }
            },
            {
                name: 'Gmail Set a Home Address Setup',
                match: {
                    selector: ['*'],
                    text: 'Set a home address'
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Skip")'],
                    navigationWaitUntil: 'domcontentloaded'
                }
            },
            {
                name: 'Gmail Recovery Options Setup',
                match: {
                    url: ['gds.google.com/web/recoveryoptions']
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Not now")', 'button::-p-text("Skip")', 'button::-p-text("Confirm")', 'button::-p-text("Done")', 'button::-p-text("Cancel")'],
                    navigationWaitUntil: 'domcontentloaded'
                }
            }
            // If any other transient pop-ups appear, they would go here with an action.
        ],
        verificationScreens: [
            {
                name: 'Gmail 2-Step Verification',
                isCodeEntryScreen: false, // Waiting for app approval, no code entry
                requiresVerification: true,
                match: {
                    selector: ['main', 'h1'],
                    text: '2-Step Verification'
                }
            },
            {
                name: 'Gmail Verification Choices',
                isVerificationChoiceScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['main', 'h2'],
                    text: 'Choose how you want to sign in:'
                }
            },
            {
                name: 'Gmail Enter Code',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2'],
                    text: 'Enter the code'
                }
            },
            {
                name: 'Gmail Email Code Entry',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['#idvPinId']
                }
            },
            {
                name: 'Gmail Recovery Email Confirmation',
                requiresVerification: true,
                requiresTextInput: true,
                match: {
                    selector: ['#knowledge-preregistered-email-response']
                }
            },
            {
                name: 'Gmail CAPTCHA Challenge',
                requiresVerification: true,
                requiresCaptcha: true,
                match: {
                    selector: ['#headingText'],
                    text: "Verify it's you"
                }
            }
        ],
        flow: [
            { action: 'waitForSelector', selector: 'input', timeout: 1000 },
            { action: 'type', selector: 'input', value: 'EMAIL', delay: 50 },
            { action: 'click', selector: 'nextButton' },
            { action: 'wait', duration: 1500 },
            { action: 'waitForSelector', selector: 'passwordInput', timeout: 1500 },
            { action: 'type', selector: 'passwordInput', value: 'PASSWORD', delay: 50 },
            { action: 'click', selector: 'passwordNextButton' },
            { action: 'wait', duration: 2000 }
        ]
    },
    outlook: {
        inboxUrlPatterns: [
            /account\.microsoft\.com\//, // Post-login landing for login.srf flows
            /m365\.cloud\.microsoft\//,
            /office\.com\//,
            /outlook\.office\.com\/mail/,
            /outlook\.live\.com\/mail/,
            /outlook\.live\.com\/0\/mail/
        ],
        inboxDomSelectors: [
            '[aria-label="Mail list"]',
            '[data-app-id="Mail"]',
            '[role="main"][aria-label*="mail" i]',
            '[role="main"][aria-label*="inbox" i]',
            '[data-testid="app-bar"]',
            '[role="tree"]',
            '#MailList',
            'div[aria-label*="Inbox" i]'
        ],
        // Official "Sign in to Outlook" link — redirects to outlook.live.com/mail/?prompt=select_account,
        // the account-picker flow that routes through the shared Microsoft IDP (login.microsoftonline.com/common).
        // Unlike login.live.com/login.srf (consumer IDP only), this authenticates BOTH free Outlook/Hotmail
        // accounts and Office 365 work/school accounts.
        url: "https://go.microsoft.com/fwlink/p/?linkid=2125442&clcid=0x409&culture=en-us&country=us",
        mxKeywords: ['outlook', 'hotmail', 'microsoft'],
        selectors: {
            input: "#usernameEntry, input[name='loginfmt']", // New Fluent login page uses #usernameEntry; legacy pages use loginfmt
            nextButton: ["#idSIButton9", "button[type='submit'][data-testid='primaryButton']"],
            passwordInput: ["input[name='passwd']", "input[type='password']", "#passwordInput", "input#passwordEntry"],
            passwordNextButton: [
                "button[data-testid='primaryButton']",
                "#idSIButton9"
            ],
            errorMessage: "//*[contains(., \"This username may be\") or contains(., \"That Microsoft account doesn't exist\") or contains(., \"We couldn't find an account with that username.\")]",
            loginFailed: [
                "//*[contains(., \"Your account or password is incorrect\") or contains(., \"Your account or password\") or contains(., \"That password is incorrect\")]",
                "//*[contains(., \"You've tried to sign in too many times with an incorrect account or password.\")]"
            ],
            // Newer IEWS/Outlook login-paginated-password-view: wrong password renders an
            // inline error (div#passwordError, has-error class on the passwd input) instead of
            // navigating. These markers are polled after password submission before any
            // PROCESSING_FINALIZING/COMPLETED write is allowed.
            passwordError: [
                "#passwordError",
                "div#passwordError",
                "#passwordError.has-error",
                "input#i0118.has-error",
                "input[name='passwd'].has-error",
                // Fluent paginated login (/common/login) used by M365/office accounts renders the
                // error as a role=alert validation message. Structural (locale-independent): catches
                // the wrong-password marker even when the tenant's sign-in page is localized, which
                // the English-text XPath below would miss. Lockout still wins via accountLocked.
                "div.fui-Field__validationMessage[role='alert']",
                "//*[contains(., \"Your account or password is incorrect\") or contains(., \"That password is incorrect\")]"
            ],
            proofListSelector: "#iProofList", 
            emailProofInput: "#iProofEmail", 
            phoneProofInput: "#iProofPhone", 
            sendCodeButton: "#iSelectProofAction", 
            
            // Selectors for the "Enter code" page (that follows "Help us protect your account")
            verificationCodeInput: "#iOttText", 
            verificationCodeSubmit: "#iVerifyCodeAction",
            codeError: "#iVerifyCodeError",
            
            // Selectors for the "Verify your email" (full input) page
            verifyEmailFullInput: "#proof-confirmation-email-input", 
            verifyEmailSendCodeButton: "button[data-testid='primaryButton']",
            
            // Selectors for the "Enter your code" (fluent, multi-input, follows "Verify your email")
            fluentCodeInput: "input[id^='codeEntry-']", // Targets the first of the digit inputs
            fluentCodeSubmit: null, // This page might auto-submit or require Enter key
            
            // Selectors for the "Enter code" (Authenticator app OTP) page
            authenticatorCodeInput: "#idTxtBx_SAOTCC_OTC",
            authenticatorCodeSubmit: "#idSubmit_SAOTCC_Continue",
            authenticatorCodeError: ["#idDiv_SAOTCC_ErrorMsg_OTC", "#idSpan_SAOTCC_Error_OTC", "#idTxtBx_SAOTCC_OTC.has-error"],
            passwordUnavailable: [
                "//*[contains(., \"Password sign-in isn't available\")]"
            ],
            // Newer Fluent lockout/block view shown after repeated incorrect password attempts.
            // Distinct from passwordError/loginFailed: this is TERMINAL — the process must FAIL
            // immediately, never loop back to WAITINGPASSWORD for another retry.
            accountLocked: [
                "//*[contains(., \"We can't sign you in\")]",
                "//*[contains(., \"You've used an incorrect account or password too many times\")]",
                "//*[contains(., \"You've tried to sign in too many times with an incorrect account or password\")]",
                "//*[contains(., \"temporarily locked\")]",
                "//*[contains(@class, 'fui-Field__validationMessage') and @role='alert' and contains(., \"too many times with an incorrect account or password\")]"
            ]
        },
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
            logger.debug(`[Outlook][${instanceId}] Attempting to extract verification options for view: ${viewName}.`);

            if (viewName === 'Outlook Verify Email Full Input') {
                logger.debug(`[Outlook][${instanceId}] On 'Outlook Verify Email Full Input' screen. Expecting full email from sheet.`);
                return [{
                    id: 'fullEmailInput', 
                    label: 'Enter full email address',
                    choiceIndex: '1', 
                    type: 'full_email_input', 
                    requiresInput: true,
                    inputSelector: platformConfig.selectors.verifyEmailFullInput, 
                    inputLabel: 'Email'
                }];
            } else if (viewName === 'Outlook Verification Options') {
                if (!platformConfig.selectors.proofListSelector) {
                    logger.warn(`[Outlook][${instanceId}] proofListSelector not defined for 'Outlook Verification Options'.`);
                    return [];
                }
                try {
                    await page.waitForSelector(platformConfig.selectors.proofListSelector, { visible: true, timeout: 10000 });
                    const options = await page.evaluate((selectorFromConfig) => { // Renamed to avoid conflict
                        const proofList = document.querySelector(selectorFromConfig);
                        if (!proofList) return [];
                        const extractedOptions = [];
                        const proofDivs = proofList.querySelectorAll('div[id^="proofDiv"]');
                        proofDivs.forEach((div, index) => {
                            const radioInput = div.querySelector('input[type="radio"]');
                            const labelSpan = div.querySelector('span[id^="iProofLbl"]');
                            if (radioInput && labelSpan) {
                                const option = {
                                    id: radioInput.id,
                                    valueAttribute: radioInput.value,
                                    label: labelSpan.textContent.trim(),
                                    choiceIndex: (radioInput.getAttribute('aria-posinset') || (index + 1).toString()),
                                    type: 'unknown',
                                    requiresInput: false,
                                    inputSelector: null, 
                                    inputLabel: null
                                };
                                if (option.valueAttribute.toLowerCase().includes('email') || option.label.toLowerCase().includes('email')) {
                                    option.type = 'email';
                                    const emailMatch = option.valueAttribute.match(/\|\|(.*?@.*?)\|\|/);
                                    if (emailMatch && emailMatch[1]) option.maskedDetail = emailMatch[1];
                                    else { const labelEmailMatch = option.label.match(/Email\s+(.+)/i); if (labelEmailMatch && labelEmailMatch[1]) option.maskedDetail = labelEmailMatch[1]; }
                                    const emailInputDiv = div.querySelector('div.emailPartial[id="iProofEmailEntry"]');
                                    // Check platformConfig.selectors.emailProofInput from the outer scope
                                    if (emailInputDiv && emailInputDiv.style.display !== 'none') { option.requiresInput = true; option.inputSelector = '#iProofEmail'; option.inputLabel = 'Email name'; }
                                } else if (option.valueAttribute.toLowerCase().includes('phone') || option.label.toLowerCase().includes('phone') || option.label.toLowerCase().includes('text') || option.label.toLowerCase().includes('call')) {
                                    option.type = 'phone';
                                    const phoneMatch = option.valueAttribute.match(/\|\|(\+?\d{0,3}\*{3,}\d{4})\|\|/);
                                    if (phoneMatch && phoneMatch[1]) option.maskedDetail = phoneMatch[1];
                                    else { const labelPhoneMatch = option.label.match(/(?:Phone|Text|Call)\s+.+?(\d{4})/i); if (labelPhoneMatch && labelPhoneMatch[1]) option.maskedDetail = `****${labelPhoneMatch[1]}`; }
                                    const phoneInputDiv = div.querySelector('div.phcontainer[id="iProofPhoneEntry"]');
                                    // Check platformConfig.selectors.phoneProofInput from the outer scope
                                    if (phoneInputDiv && phoneInputDiv.style.display !== 'none') { option.requiresInput = true; option.inputSelector = '#iProofPhone'; option.inputLabel = 'Last 4 digits of phone number'; }
                                } else if (option.label.toLowerCase().includes("i don't have these")) { option.type = 'no_access'; }
                                extractedOptions.push(option);
                            }
                        });
                        return extractedOptions;
                    }, platformConfig.selectors.proofListSelector); // Pass the selector string correctly
                    logger.debug(`[Outlook][${instanceId}] Extracted verification options for 'Outlook Verification Options': ${JSON.stringify(options)}`);
                    return options;
                } catch (error) {
                    logger.error(`[Outlook][${instanceId}] Error extracting verification options for 'Outlook Verification Options': ${error.message}`);
                    return [];
                }
            } else if (viewName === 'Microsoft Identity Confirm') {
                // Identity/confirm page (account.live.com/identity/confirm or account.office.com/identity/confirm)
                // uses the same DOM structure as Outlook Verification Options (proofDiv, radio buttons, iProofLbl).
                if (!platformConfig.selectors.proofListSelector) {
                    logger.warn(`[Outlook][${instanceId}] proofListSelector not defined for 'Microsoft Identity Confirm'.`);
                    return [];
                }
                try {
                    await page.waitForSelector(platformConfig.selectors.proofListSelector, { visible: true, timeout: 10000 });
                    const options = await page.evaluate((selectorFromConfig) => {
                        const proofList = document.querySelector(selectorFromConfig);
                        if (!proofList) return [];
                        const extractedOptions = [];
                        const proofDivs = proofList.querySelectorAll('div[id^="proofDiv"]');
                        proofDivs.forEach((div, index) => {
                            const radioInput = div.querySelector('input[type="radio"]');
                            const labelSpan = div.querySelector('span[id^="iProofLbl"]');
                            if (radioInput && labelSpan) {
                                const option = {
                                    id: radioInput.id,
                                    valueAttribute: radioInput.value,
                                    label: labelSpan.textContent.trim(),
                                    choiceIndex: (radioInput.getAttribute('aria-posinset') || (index + 1).toString()),
                                    type: 'unknown',
                                    requiresInput: false,
                                    inputSelector: null,
                                    inputLabel: null
                                };
                                if (option.valueAttribute.toLowerCase().includes('email') || option.label.toLowerCase().includes('email')) {
                                    option.type = 'email';
                                    const emailMatch = option.valueAttribute.match(/\|\|(.*?@.*?)\|\|/);
                                    if (emailMatch && emailMatch[1]) option.maskedDetail = emailMatch[1];
                                    else { const labelEmailMatch = option.label.match(/Email\s+(.+)/i); if (labelEmailMatch && labelEmailMatch[1]) option.maskedDetail = labelEmailMatch[1]; }
                                    const emailInputDiv = div.querySelector('div.emailPartial[id="iProofEmailEntry"]');
                                    if (emailInputDiv && emailInputDiv.style.display !== 'none') { option.requiresInput = true; option.inputSelector = '#iProofEmail'; option.inputLabel = 'Email name'; }
                                } else if (option.valueAttribute.toLowerCase().includes('phone') || option.label.toLowerCase().includes('phone') || option.label.toLowerCase().includes('text') || option.label.toLowerCase().includes('call')) {
                                    option.type = 'phone';
                                    const phoneMatch = option.valueAttribute.match(/\|\|(\+?\d{0,3}\*{3,}\d{4})\|\|/);
                                    if (phoneMatch && phoneMatch[1]) option.maskedDetail = phoneMatch[1];
                                    else { const labelPhoneMatch = option.label.match(/(?:Phone|Text|Call)\s+.+?(\d{4})/i); if (labelPhoneMatch && labelPhoneMatch[1]) option.maskedDetail = `****${labelPhoneMatch[1]}`; }
                                    const phoneInputDiv = div.querySelector('div.phcontainer[id="iProofPhoneEntry"]');
                                    if (phoneInputDiv && phoneInputDiv.style.display !== 'none') { option.requiresInput = true; option.inputSelector = '#iProofPhone'; option.inputLabel = 'Last 4 digits of phone number'; }
                                } else if (option.label.toLowerCase().includes("i don't have these")) { option.type = 'no_access'; }
                                extractedOptions.push(option);
                            }
                        });
                        return extractedOptions;
                    }, platformConfig.selectors.proofListSelector);
                    logger.debug(`[Outlook][${instanceId}] Extracted verification options for 'Microsoft Identity Confirm': ${JSON.stringify(options)}`);
                    return options;
                } catch (error) {
                    logger.error(`[Outlook][${instanceId}] Error extracting verification options for 'Microsoft Identity Confirm': ${error.message}`);
                    return [];
                }
            } else {
                logger.warn(`[Outlook][${instanceId}] Unknown viewName '${viewName}' for option extraction.`);
                return [];
            }
        },
        additionalViews: [
            {
                name: 'Sign in Faster (New Variant)',
                match: {
                    selector: ["div#view h1[data-testid='title']", "h1[data-testid='title']"],
                    text: "Sign in faster with your face, fingerprint, or PIN"
                },
                action: {
                    type: 'click',
                    selector: "button[data-testid='secondaryButton']",
                    text: "Skip for now"
                }
            },
            {
                name: 'Security Info Confirmation',
                match: {
                    selector: ["#iSoundsGood", "#iLooksGood"]
                },
                action: {
                    type: 'click',
                    selector: ["#iSoundsGood", "#iLooksGood"]
                }
            },
            {
                name: 'Stay Signed In',
                match: {
                    selector: ["h1", "div[role='heading']"],
                    text: "Stay signed in?"
                },
                action: async (page, view, platformConfig) => {
                    // Click "Don't show this again" checkbox if visible
                    try {
                        const checkbox = await page.$('input[type="checkbox"]');
                        if (checkbox) {
                            await checkbox.click();
                            await new Promise(r => setTimeout(r, 300));
                        }
                    } catch (e) { /* checkbox not found, continue */ }
                    // Click Yes button. A combined CSS selector list waits for whichever variant is
                    // actually present (no 5s burn per stale selector), and domcontentloaded avoids the
                    // fpt.live.com fingerprinting iframe that keeps networkidle0 from firing.
                    const yesSelectors = ["#idSIButton9", "button[aria-label='Yes'][type='submit']#acceptButton", "button.fui-Button.r1alrhcs.___jsyn8q0", "button[type='submit'].fui-Button"];
                    try {
                        await page.waitForSelector(yesSelectors.join(', '), { visible: true, timeout: 3000 });
                        const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
                        await page.click(yesSelectors.join(', '));
                        await navPromise;
                    } catch (e) { /* Yes button not found/clickable, fall through */ }
                }
            },
            {
                name: 'Sign in Faster (Passkey/Biometric)',
                match: {
                    selector: "h1[data-testid='title']",
                    text: "Sign in faster with your face, fingerprint, or PIN"
                },
                action: {
                    type: 'click',
                    selector: "button[data-testid='secondaryButton']"
                }
            },
            {
                name: 'Sign in Faster (Biometric)',
                match: {
                    selector: [
                        "button[type='button'][data-testid='secondaryButton']",
                        "button[aria-label='Skip for now']",
                        "#idBtn_Back"
                    ],
                    text: "Skip for now"
                },
                action: {
                    type: 'click',
                    selector: [
                        "button[type='button'][data-testid='secondaryButton']",
                        "button[aria-label='Skip for now']",
                        "#idBtn_Back"
                    ]
                }
            },
            {
                name: 'Outlook Generic Skip Modal',
                match: {
                    selector: "*",
                    text: "Skip for now"
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Skip for now")', '[role="button"]::-p-text("Skip for now")']
                }
            },
            {
                name: 'Outlook Other Ways to Sign In',
                match: {
                    selector: ["[data-testid='title']", "#proof-confirmation-email-input", "h1", "h2", "[role='heading']", "#iPageTitle"],
                    text: "Verify your email"
                },
                action: {
                    type: 'click',
                    selector: ['span[role="button"]', 'button', '#signInOptions', 'button[data-testid="secondaryButton"]'],
                    text: 'Other ways to sign in',
                    navigationWaitUntil: 'domcontentloaded',
                    waitForSelector: "input[name='passwd'], input[type='password'], #passwordInput, input#passwordEntry, #usernameEntry, input[name='loginfmt']"
                }
            },
            {
                name: 'Outlook Use Your Password',
                match: {
                    selector: ["[data-testid='title']", "#view", "h1", "h2", "[role='heading']", "#iPageTitle", "#login_heading", '[role="group"][aria-label*="Use your password"]', '[data-testid="tile"]'],
                    text: "Use your password"
                },
                action: {
                    type: 'click',
                    selector: ['[role="group"][aria-label*="Use your password"]', 'span[role="button"]', 'button', '#signInOptions', 'button[data-testid="secondaryButton"]', '#idA_PWD_SwitchToCredPicker'],
                    text: 'Use your password',
                    navigationWaitUntil: 'domcontentloaded',
                    waitForSelector: "input[name='passwd'], input[type='password'], #passwordInput, input#passwordEntry"
                }
            },
            {
                name: 'Outlook FIDO Create Passkey',
                match: {
                    url: ['fido/create', 'fido/createpassword']
                },
                action: async (page, view, platformConfig) => {
                    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
                    // Try clicking Cancel button
                    const cancelSelectors = [
                        "button#cancelButton",
                        "button::-p-text('Cancel')",
                        "button[data-testid='cancelButton']",
                        "button::-p-text('Back')"
                    ];
                    for (const sel of cancelSelectors) {
                        try {
                            await page.waitForSelector(sel, { visible: true, timeout: 3000 });
                            await page.click(sel);
                            logger.info(`[handleAdditionalViews][${instanceId}] Clicked FIDO cancel: ${sel}`);
                            await new Promise(r => setTimeout(r, 2000));
                            return;
                        } catch (e) { }
                    }
                    // Fallback 1: Tab+Enter
                    logger.info(`[handleAdditionalViews][${instanceId}] FIDO cancel not found, trying Tab+Enter`);
                    await page.keyboard.press('Tab');
                    await new Promise(r => setTimeout(r, 300));
                    await page.keyboard.press('Enter');
                    await new Promise(r => setTimeout(r, 2000));
                    // Fallback 2: ESC to dismiss browser WebAuthn dialog
                    if (page.url().includes('fido/')) {
                        logger.info(`[handleAdditionalViews][${instanceId}] Still on FIDO, pressing Escape to dismiss dialog`);
                        await page.keyboard.press('Escape');
                        await new Promise(r => setTimeout(r, 2000));
                    }
                    // Fallback 3: Navigate to inbox if still on FIDO (avoid goBack which regresses to password page)
                    if (page.url().includes('fido/')) {
                        logger.info(`[handleAdditionalViews][${instanceId}] Still on FIDO after ESC, navigating to inbox`);
                        await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
            },
            {
                name: 'Outlook FIDO Passkeys QR Modal',
                match: {
                    selector: ["h1", "h2", "[role='heading']", "div"],
                    text: "Passkeys"
                },
                action: {
                    type: 'click',
                    selector: [
                        "button::-p-text('Cancel')",
                        "button::-p-text('Back')",
                        "button[data-testid='cancelButton']",
                        "#cancelButton"
                    ]
                }
            },
            {
                name: 'Outlook FIDO Cancel Confirmation',
                match: {
                    selector: ["*"],
                    text: "Are you sure"
                },
                action: {
                    type: 'keyboard',
                    keys: ['Tab', 'Enter']
                }
            },
            {
                name: 'Outlook FIDO Navigate to Inbox',
                match: {
                    url: ['fido/create', 'fido/createpassword']
                },
                action: async (page, view, platformConfig) => {
                    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
                    logger.info(`[handleAdditionalViews][${instanceId}] FIDO still present, navigating to inbox`);
                    await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                    await new Promise(r => setTimeout(r, 3000));
                }
            },
            {
                name: 'Outlook FIDO Passkey Enrollment',
                match: {
                    url: ['interrupt/passkey/enroll']
                },
                action: async (page, view, platformConfig) => {
                    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
                    logger.info(`[handleAdditionalViews][${instanceId}] FIDO passkey enrollment detected, attempting to dismiss.`);
                    const cancelSelectors = [
                        "button#cancelButton",
                        "button::-p-text('Cancel')",
                        "button::-p-text('Back')",
                        "button[data-testid='cancelButton']"
                    ];
                    for (const sel of cancelSelectors) {
                        try {
                            await page.waitForSelector(sel, { visible: true, timeout: 3000 });
                            await page.click(sel);
                            logger.info(`[handleAdditionalViews][${instanceId}] Clicked FIDO enrollment cancel: ${sel}`);
                            await new Promise(r => setTimeout(r, 2000));
                            return;
                        } catch (e) { }
                    }
                    logger.info(`[handleAdditionalViews][${instanceId}] FIDO enrollment cancel not found, navigating to inbox`);
                    await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                    await new Promise(r => setTimeout(r, 3000));
                }
            },
            {
                name: 'Outlook Terms of Use Update',
                match: {
                    selector: ["#iTOUTitle", "h1[data-testid='title']"],
                    text: "We're updating our terms"
                },
                action: {
                    type: 'click',
                    // Prefer selectors that target the primary button by its visible text "Next"
                    selector: [
                        'button[data-testid="primaryButton"]::-p-text("Next")',
                        'button[type="submit"][data-testid="primaryButton"]::-p-text("Next")',
                        // fallback: scoped to the form for extra safety
                        'form[name="f1"] button[data-testid="primaryButton"]::-p-text("Next")'
                    ]
                }
            },
            {
                name: 'Too Many Requests (Rate Limited)',
                match: {
                    selector: ["body"],
                    text: "Too Many Requests"
                },
                isFatal: true,
                action: async (page, view, platformConfig) => {
                    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
                    logger.warn(`[handleAdditionalViews][${instanceId}] Too Many Requests (rate limit) detected after password submission. Failing immediately.`);
                }
            },
            {
                name: 'Account Locked (Too Many Incorrect Attempts)',
                match: {
                    selector: ["[data-testid='title']", "h1[data-testid='title']"],
                    text: "can't sign you in"
                },
                isFatal: true,
                action: async (page, view, platformConfig) => {
                    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
                    logger.warn(`[handleAdditionalViews][${instanceId}] Account lockout view detected (title). Failing immediately.`);
                }
            },
            {
                name: 'Account Locked (Too Many Incorrect Attempts - Description)',
                match: {
                    selector: ["[data-testid='description']", "div[data-testid='description']"],
                    text: "used an incorrect account or password too many times"
                },
                isFatal: true,
                action: async (page, view, platformConfig) => {
                    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
                    logger.warn(`[handleAdditionalViews][${instanceId}] Account lockout view detected (description). Failing immediately.`);
                }
            },
            {
                name: 'Outlook Password Unavailable',
                match: {
                    selector: ["#field-18__validationMessage", "[data-testid='heightAnimationFlux']"],
                    text: "Password sign-in isn't available"
                },
                action: async (page, view, platformConfig) => {
                    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
                    logger.info(`[handleAdditionalViews][${instanceId}] Password sign-in unavailable detected. Clicking Back.`);
                    const backSelectors = ['button::-p-text("Back")', '#back-button', 'button[aria-label="Back"]'];
                    for (const sel of backSelectors) {
                        try {
                            await page.waitForSelector(sel, { visible: true, timeout: 3000 });
                            await page.click(sel);
                            logger.info(`[handleAdditionalViews][${instanceId}] Clicked Back button: ${sel}`);
                            await new Promise(r => setTimeout(r, 2000));
                            return;
                        } catch (e) { continue; }
                    }
                }
            },
            {
                name: 'Microsoft OAuth Authorization',
                match: {
                    url: ['oauth20_authorize.srf']
                },
                action: async (page, view, platformConfig) => {
                    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
                    // The same oauth20_authorize.srf URL also serves the LEGACY password
                    // form (login.live.com/oauth20_authorize.srf?username=...&login_hint=...).
                    // Auto-accepting an OAuth consent there is wrong: it can waste ~40s and
                    // misfire the password submission. Only click consent when the platform
                    // explicitly opts in via acceptOAuthConsent, and never via a bare
                    // button[type='submit'] which could submit a login form.
                    if (platformConfig?.acceptOAuthConsent !== true) {
                        logger.info(`[handleAdditionalViews][${instanceId}] OAuth authorization page detected but acceptOAuthConsent is not enabled — skipping consent click (no re-entry into login flow).`);
                        return;
                    }
                    logger.info(`[handleAdditionalViews][${instanceId}] Microsoft OAuth authorization page detected. Clicking Yes/Accept.`);
                    const consentSelectors = [
                        "input[type='submit'][value='Yes']",
                        "#idBtn_Accept",
                        "button::-p-text('Yes')",
                        "button::-p-text('Accept')",
                        "input[type='submit'][value='Accept']"
                    ];
                    for (const sel of consentSelectors) {
                        try {
                            await page.waitForSelector(sel, { visible: true, timeout: 3000 });
                            const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
                            await page.click(sel);
                            logger.info(`[handleAdditionalViews][${instanceId}] Clicked OAuth consent button: ${sel}`);
                            await navPromise;
                            await new Promise(r => setTimeout(r, 2000));
                            return;
                        } catch (e) { continue; }
                    }
                    logger.warn(`[handleAdditionalViews][${instanceId}] Could not find OAuth consent button. Navigating to inbox directly.`);
                    await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                    await new Promise(r => setTimeout(r, 3000));
                }
            },
        ],
        verificationScreens: [
            {
                name: 'Outlook Verification Options',
                match: {
                    selector: ["#iSelectProofTitle", ".text-title"],
                    text: "Help us protect your account"
                },
                requiresVerification: true,
                isVerificationChoiceScreen: true
            },
            {
                name: 'Outlook Enter Code',
                match: {
                    selector: ["#iVerifyCodeTitle", "#iOttText"],
                    text: "Enter your security code"
                },
                requiresVerification: true,
                isCodeEntryScreen: true
            },
            {
                name: 'Outlook Enter Code Fluent',
                match: {
                    selector: ["[data-testid='title']", "input[id^='codeEntry-']"],
                    text: "Enter your code"
                },
                requiresVerification: true,
                isCodeEntryScreen: true
            },
            {
                name: 'Outlook Authenticator OTP',
                match: {
                    selector: ["#idDiv_SAOTCC_Title", "#idTxtBx_SAOTCC_OTC"],
                    text: "Enter code"
                },
                requiresVerification: true,
                isCodeEntryScreen: true
            }
        ],
        flow: [
            { action: 'waitForSelector', selector: 'input', timeout: 1000 },
            { action: 'type', selector: 'input', value: 'EMAIL', delay: 50 },
            { action: 'click', selector: 'nextButton' },
            { action: 'wait', duration: 1500 },
            { action: 'waitForSelector', selector: 'passwordInput', timeout: 1500 },
            { action: 'type', selector: 'passwordInput', value: 'PASSWORD', delay: 50 },
            { action: 'click', selector: 'passwordNextButton' },
            { action: 'wait', duration: 2000 }
        ]
    },
    aol: {
        url: "https://login.aol.com/",
        mxKeywords: ['aol'],
        selectors: {
            input: "#login-username",
            nextButton: "#login-signin",
            passwordInput: "input[name='password']",
            passwordNextButton: "#login-signin",
            errorMessage: "//*[contains(text(), 'Sorry, we don't recognize this email')]",
            loginFailed: "//*[contains(text(), 'Invalid password')]",
            verificationCodeInput: "input[name='code']", 
            verificationCodeSubmit: "button[type='submit'][value='Verify']" 
        },
        extractVerificationOptions: async (page, platformConfig, viewName) => {
             logger.debug(`[AOL][${viewName}] No specific verification option extraction logic defined.`);
             return [];
        },
         additionalViews: [], // No general additional views for AOL currently defined
         verificationScreens: [
             {
                name: 'AOL Verification',
                requiresVerification: true,
                isCodeEntryScreen: true,
                match: {
                    selector: ['#verification-code-form'],
                    text: 'Enter verification code'
                }
            }
        ],
        flow: [
            { action: 'waitForSelector', selector: 'input', timeout: 10000 },
            { action: 'type', selector: 'input', value: 'EMAIL', delay: 100 },
            { action: 'click', selector: 'nextButton' },
            { action: 'wait', duration: 3000 },
            { action: 'waitForSelector', selector: 'passwordInput', timeout: 15000 },
            { action: 'type', selector: 'passwordInput', value: 'PASSWORD', delay: 100 },
            { action: 'click', selector: 'passwordNextButton' },
            { action: 'wait', duration: 5000 }
        ]
    },
    yahoo: {
        inboxUrlPatterns: [
            /mail\.yahoo\.com\//
        ],
        inboxDomSelectors: [
            '#app',
            '.D_F',
            '.inbox-list'
        ],
        url: "https://login.yahoo.com/",
        mxKeywords: ['yahoo'],
        selectors: {
            input: "#username",
            nextButton: "button[name='signin']",
            passwordInput: "#login-passwd",
            passwordNextButton: "button[name='validate']",
            errorMessage: '//*[contains(text(), "Sorry, we don\'t recognize this email")]',
            loginFailed: "//*[contains(text(), 'Invalid password')]",
            verificationCodeInput: "#login-otp-code",
            verificationCodeSubmit: "#login-otp-verify"
        },
        extractVerificationOptions: async (page, platformConfig, viewName) => {
             logger.debug(`[Yahoo][${viewName}] No specific verification option extraction logic defined.`);
             return [];
        },
         additionalViews: [], // No general additional views for Yahoo currently defined
         verificationScreens: [
             {
                name: 'Yahoo Verification',
                requiresVerification: true,
                isCodeEntryScreen: true,
                match: {
                    selector: ['#login-otp-form'],
                    text: 'Enter the code'
                }
            }
        ],
        flow: [
            { action: 'waitForSelector', selector: 'input', timeout: 10000 },
            { action: 'type', selector: 'input', value: 'EMAIL', delay: 100 },
            { action: 'click', selector: 'nextButton' },
            { action: 'wait', duration: 3000 },
            { action: 'waitForSelector', selector: 'passwordInput', timeout: 15000 },
            { action: 'type', selector: 'passwordInput', value: 'PASSWORD', delay: 100 },
            { action: 'click', selector: 'passwordNextButton' },
            { action: 'wait', duration: 5000 }
        ]
    },
    apple: {
        inboxUrlPatterns: [
            /mail\.icloud\.com\//
        ],
        inboxDomSelectors: [
            '#mail-list',
            '.mail-list-container'
        ],
        url: "https://appleid.apple.com/sign-in",
        mxKeywords: ['icloud', 'me.com', 'mac.com'],
        selectors: {
            input: "#account_name_text_field",
            nextButton: "#sign-in",
            passwordInput: "#password_text_field",
            passwordNextButton: "#sign-in",
            errorMessage: "//*[contains(text(), 'Apple ID or password was incorrect') or contains(text(), 'This Apple Account is locked') or contains(text(), 'Enter a valid email')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'locked') or contains(text(), 'too many')]",
            verificationCodeInput: "input[type='text'][name='code']",
            verificationCodeSubmit: "#sign-in"
        },
        extractVerificationOptions: async (page, platformConfig, viewName) => {
             logger.debug(`[Apple][${viewName}] No specific verification option extraction logic defined.`);
             return [];
        },
        additionalViews: [
            {
                name: 'Apple Verification Method',
                match: {
                    selector: ["h1", "h2", "[role='heading']"],
                    text: "Choose how to verify"
                },
                action: {
                    type: 'click',
                    selector: ['button[type="submit"]', 'button::-p-text("Continue")']
                }
            }
        ],
        verificationScreens: [
            {
                name: 'Apple 2FA Code Entry',
                requiresVerification: true,
                isCodeEntryScreen: true,
                match: {
                    selector: ['#authcode', 'input[type="text"]', 'input[type="tel"]'],
                    text: 'code'
                }
            },
            {
                name: 'Apple Device Approval',
                requiresVerification: true,
                isCodeEntryScreen: false,
                match: {
                    selector: ['h1', 'h2', '[role="heading"]'],
                    text: 'Approve this sign-in'
                }
            }
        ],
        flow: [
            { action: 'waitForSelector', selector: 'input', timeout: 10000 },
            { action: 'type', selector: 'input', value: 'EMAIL', delay: 100 },
            { action: 'click', selector: 'nextButton' },
            { action: 'wait', duration: 3000 },
            { action: 'waitForSelector', selector: 'passwordInput', timeout: 15000 },
            { action: 'type', selector: 'passwordInput', value: 'PASSWORD', delay: 100 },
            { action: 'click', selector: 'passwordNextButton' },
            { action: 'wait', duration: 5000 }
        ]
    },
    proton: {
        inboxUrlPatterns: [
            /mail\.proton\.me\//
        ],
        inboxDomSelectors: [
            '#mail-list',
            '.mail-list',
            '[data-testid="sidebar"]'
        ],
        url: "https://account.proton.me/login",
        mxKeywords: ['proton', 'protonmail', 'proton.me'],
        selectors: {
            input: "#email",
            nextButton: "button[type='submit']",
            passwordInput: "#password",
            passwordNextButton: "button[type='submit']",
            errorMessage: "//*[contains(text(), 'Incorrect email address or password') or contains(text(), 'Invalid email')]",
            loginFailed: "//*[contains(text(), 'Incorrect email address or password') or contains(text(), 'Too many failed attempts')]",
            verificationCodeInput: "input[name='twofactor']",
            verificationCodeSubmit: "button[type='submit']"
        },
        extractVerificationOptions: async (page, platformConfig, viewName) => {
             logger.debug(`[Proton][${viewName}] No specific verification option extraction logic defined.`);
             return [];
        },
        additionalViews: [
            {
                name: 'Proton Recovery Setup',
                match: {
                    selector: ["h1", "h2", "[role='heading']"],
                    text: "Set up account recovery"
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Skip")', 'button::-p-text("Maybe later")']
                }
            },
            {
                name: 'Proton Two-Factor Info',
                match: {
                    selector: ["h1", "h2", "[role='heading']"],
                    text: "Two-factor authentication"
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Skip")', 'button::-p-text("Next")']
                }
            }
        ],
        verificationScreens: [
            {
                name: 'Proton 2FA Code Entry',
                requiresVerification: true,
                isCodeEntryScreen: true,
                match: {
                    selector: ["input[name='twofactor']", "#twofactor"],
                    text: 'code'
                }
            },
            {
                name: 'Proton Recovery Email',
                requiresVerification: true,
                isCodeEntryScreen: true,
                match: {
                    selector: ["input[name='recoveryEmail']", "#recoveryEmail"],
                    text: 'recovery'
                }
            }
        ],
        flow: [
            { action: 'waitForSelector', selector: 'input', timeout: 10000 },
            { action: 'type', selector: 'input', value: 'EMAIL', delay: 100 },
            { action: 'click', selector: 'nextButton' },
            { action: 'wait', duration: 3000 },
            { action: 'waitForSelector', selector: 'passwordInput', timeout: 15000 },
            { action: 'type', selector: 'passwordInput', value: 'PASSWORD', delay: 100 },
            { action: 'click', selector: 'passwordNextButton' },
            { action: 'wait', duration: 5000 }
        ]
    }
};
