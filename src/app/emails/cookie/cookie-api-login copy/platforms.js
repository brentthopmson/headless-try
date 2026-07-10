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
                    selector: ['button::-p-text("Cancel")'],
                    navigationWaitUntil: 'networkidle0'
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
                    navigationWaitUntil: 'networkidle0'
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
            /m365\.cloud\.microsoft\//,
            /office\.com\//
        ],
        inboxDomSelectors: [
            '[aria-label="Mail list"]'
        ],
        url: "https://login.microsoftonline.com/",
        mxKeywords: ['outlook', 'hotmail', 'microsoft'],
        selectors: {
            input: "input[name='loginfmt']",
            nextButton: ["#idSIButton9", "button[type='submit'][data-testid='primaryButton']"],
            passwordInput: "input#passwordEntry",
            passwordNextButton: [
                "button[type='submit'][data-testid='primaryButton']",
                "button.fui-Button.r1alrhcs.___jsyn8q0",
                "button#idSIButton9.ext-primary.ext-button.___n08lmr0"
            ],
            errorMessage: "//*[contains(text(), \"This username may be\") or contains(text(), \"That Microsoft account doesn't exist\") or contains(text(), \"We couldn't find an account with that username.\")]",
            loginFailed: [
                "//*[contains(text(), \"Your account or password is incorrect\") or contains(text(), \"Your account or password\") or contains(text(), \"That password is incorrect\")]",
                "//*[contains(text(), \"You've tried to sign in too many times with an incorrect account or password.\")]"
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
            fluentCodeSubmit: null // This page might auto-submit or require Enter key
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
                match: { selector: "#iLooksGood" },
                action: { type: 'click', selector: "#iLooksGood" }
            },
            {
                name: 'Stay Signed In',
                match: {
                    selector: ["h1", "div[role='heading']"],
                    text: "Stay signed in?"
                },
                action: {
                    type: 'click',
                    selector: [
                        "button[aria-label='Yes'][type='submit']#acceptButton",
                        "button.fui-Button.r1alrhcs.___jsyn8q0",
                        "button[type='submit'].fui-Button"
                    ]
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
                    selector: 'span[role="button"]',
                    text: 'Other ways to sign in',
                    navigationWaitUntil: 'domcontentloaded'
                }
            },
            {
                name: 'Outlook Use Your Password',
                match: {
                    selector: ["[data-testid='title']", "#view", "h1", "h2", "[role='heading']", "#iPageTitle"],
                    text: "Use your password"
                },
                action: {
                    type: 'click',
                    selector: 'span[role="button"]',
                    text: 'Use your password',
                    navigationWaitUntil: 'domcontentloaded'
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
                    // Fallback 2: goBack if still on FIDO
                    if (page.url().includes('fido/')) {
                        logger.info(`[handleAdditionalViews][${instanceId}] Still on FIDO, going back`);
                        await page.goBack({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
                        await new Promise(r => setTimeout(r, 2000));
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
                    await page.goto('https://outlook.live.com/mail/', { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => null);
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
    }
};
