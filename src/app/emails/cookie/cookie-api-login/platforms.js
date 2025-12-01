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
            passwordInput: "input[name='Passwd']",
            passwordNextButton: "#passwordNext",
            errorMessage: "//*[contains(text(), \"Couldn't find your Google Account\") or contains(text(), \"Enter an email\") or contains(text(), \"Enter a valid email\") or contains(text(), \"Couldn’t find your Google Account\")]", // Add more as needed
            loginFailed: "//*[contains(text(), 'Wrong password') or contains(text(), 'Your password was changed')]",
            verificationCodeInput: "input[type='tel'][name='ca']",
            verificationCodeSubmit: "#idvPreregisteredPhoneNext"
        },
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            logger.debug(`[Gmail][${viewName}] No specific verification option extraction logic defined.`);
            return []; 
        },
        additionalViews: [
            // No general additional views for Gmail currently defined that are not primary verification.
            // If any transient pop-ups appear, they would go here with an action.
        ],
        verificationScreens: [
            {
                name: 'Gmail Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: [
                        '.yTaH4c .tbkBpf .Sevzkc',
                        '.vAV9bf',
                        'h1[data-a11y-title-piece]'
                    ],
                    text: 'Verify it\'s you'
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
                "//*[contains(text(), \"Your account or password is incorrect\") or contains(text(), \"Your account or password\")]",
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
            logger.info(`[Outlook][${instanceId}] Attempting to extract verification options for view: ${viewName}.`);

            if (viewName === 'Outlook Verify Email Full Input') {
                logger.info(`[Outlook][${instanceId}] On 'Outlook Verify Email Full Input' screen. Expecting full email from sheet.`);
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
                    logger.info(`[Outlook][${instanceId}] Extracted verification options for 'Outlook Verification Options': ${JSON.stringify(options)}`);
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
            { // Moved back to additionalViews as it's a click-through to proceed
                name: 'Outlook Verify Email Full Input',
                match: {
                    selector: ["[data-testid='title']", "#proof-confirmation-email-input", "body"],
                    text: "Use your password"
                },
                // Removed requiresVerification and isVerificationChoiceScreen as it's not a primary verification choice screen
                action: {
                    type: 'click',
                    selector: 'span[role="button"]',
                    text: 'Use your password',
                    navigationWaitUntil: 'domcontentloaded'
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
            input: "#login-username",
            nextButton: "#login-signin",
            passwordInput: "#login-passwd",
            passwordNextButton: "#login-signin",
            errorMessage: "//*[contains(text(), 'Sorry, we don't recognize this email')]",
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
    }
};
