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
            loginFailed: "//*[contains(text(), 'Wrong password')]"
        },
        additionalViews: [
            {
                name: 'Gmail Verification',
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
            { action: 'waitForSelector', selector: 'input', timeout: 10000 },
            { action: 'type', selector: 'input', value: 'EMAIL', delay: 50 },
            { action: 'click', selector: 'nextButton' },
            { action: 'wait', duration: 1500 },
            { action: 'waitForSelector', selector: 'passwordInput', timeout: 15000 },
            { action: 'type', selector: 'passwordInput', value: 'PASSWORD', delay: 50 },
            { action: 'click', selector: 'passwordNextButton' },
            { action: 'wait', duration: 2000 }
        ]
    },
    outlook: {
        inboxUrlPatterns: [
            /m365\.cloud\.microsoft\//
        ],
        inboxDomSelectors: [
            'div[role="main"]',
            '.ms-FocusZone',
            '.lvHighlightAllClass'
        ],
        url: "https://login.microsoftonline.com/",
        mxKeywords: ['outlook', 'hotmail', 'microsoft'],
        selectors: {
            input: "input[name='loginfmt']",
            nextButton: ["#idSIButton9", "button[type='submit'][data-testid='primaryButton']"],
            passwordInput: "input[name='passwd']",
            passwordNextButton: [
                "#passwordNext", 
                "button[type='submit'][data-testid='primaryButton']",
                "button.fui-Button.r1alrhcs.___jsyn8q0",
                "button#idSIButton9.ext-primary.ext-button.___n08lmr0"
            ],
            errorMessage: "//*[contains(text(), \"This username may be\") or contains(text(), \"That Microsoft account doesn't exist\") or contains(text(), \"We couldn't find an account with that username.\")]",
            loginFailed: "//*[contains(text(), \"Your account or password is incorrect\") or contains(text(), \"Your account or password\")]"
        },
        additionalViews: [
            {
                name: 'Protect Account',
                match: { 
                    selector: ['#ProofUpDescription', '.text-title'],
                    text: "Help us protect your account" 
                },
                requiresVerification: true
            },
            {
                name: 'Security Info Confirmation',
                match: { selector: "#iLooksGood" },
                action: { type: 'click', selector: "#iLooksGood" }
            },
            {
                name: 'Stay Signed In',
                match: { 
                    selector: [
                        "button[aria-label='Yes'][type='submit']#acceptButton",
                        "button[type='submit'][data-testid='primaryButton']",
                        "button.fui-Button.r1alrhcs.___jsyn8q0",
                        "button[type='submit'].fui-Button"
                    ], 
                    text: "Yes" 
                },
                action: { 
                    type: 'click', 
                    selector: [
                        "button[aria-label='Yes'][type='submit']#acceptButton",
                        "button[type='submit'][data-testid='primaryButton']",
                        "button.fui-Button.r1alrhcs.___jsyn8q0",
                        "button[type='submit'].fui-Button"
                    ]
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
                name: 'Sign in Faster (Biometric) - Alternate',
                match: { selector: "#idDiv_SAOTCS_Title", text: "Sign in faster" },
                action: async (page, view) => {
                    // Use the general-purpose keyboard navigation helper
                    const { keyboardNavigate } = await import('@/utils/KeyboardHandlers');
                    await keyboardNavigate(page, {
                        focusSelector: view.match.selector,
                        sequence: [
                            { key: 'Tab' },
                            { key: 'Enter' }
                        ]
                    });
                    await new Promise(res => setTimeout(res, 2000));
                }
            },

        ],
        flow: [
            { action: 'waitForSelector', selector: 'input', timeout: 10000 },
            { action: 'type', selector: 'input', value: 'EMAIL', delay: 50 },
            { action: 'click', selector: 'nextButton' },
            { action: 'wait', duration: 1500 },
            { action: 'waitForSelector', selector: 'passwordInput', timeout: 15000 },
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
            loginFailed: "//*[contains(text(), 'Invalid password')]"
        },
        additionalViews: [
            // Add AOL-specific modals here as you encounter them
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
            loginFailed: "//*[contains(text(), 'Invalid password')]"
        },
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