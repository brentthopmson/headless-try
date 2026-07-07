import logger from "../../../../utils/logger.js";

export const platformConfigs = {
    // ==================== TWITTER ====================
    twitter: {
        inboxUrlPatterns: [
            /twitter\.com\//,
            /x\.com\//
        ],
        url: "https://x.com/login",
        platform: "twitter",
        selectors: {
            input: "input[autocomplete='username']",
            nextButton: "button[type='button']:has-text('Next')",
            passwordInput: "input[type='password'][autocomplete='current-password']",
            passwordNextButton: "button[type='button']:has-text('Log in')",
            errorMessage: "//*[contains(text(), 'account not found') or contains(text(), 'The username and password do not match')]",
            loginFailed: "//*[contains(text(), 'incorrect password') or contains(text(), 'account does not exist')]",
            verificationCodeInput: "input[type='text'][placeholder*='code' i]",
            verificationCodeSubmit: "button[type='button']:has-text('Next')"
        },
        additionalViews: [
            {
                name: 'Twitter Cookie Consent',
                match: {
                    selector: ['*'],
                    text: 'Manage cookies'
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Reject non-essential cookies")'],
                    navigationWaitUntil: 'networkidle0'
                }
            },
            {
                name: 'Twitter 2FA/Security Challenge',
                match: {
                    selector: ['h1', 'div[role="heading"]'],
                    text: 'verify your identity'
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Try another way")'],
                    navigationWaitUntil: 'networkidle0'
                }
            }
        ],
        verificationScreens: [
            {
                name: 'Twitter Two-Factor Authentication',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'div[role="heading"]'],
                    text: '2-Step verification'
                }
            },
            {
                name: 'Twitter Email Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'div[role="heading"]'],
                    text: 'verify your email'
                }
            },
            {
                name: 'Twitter Phone Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'div[role="heading"]'],
                    text: 'verify your phone'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            const instanceId = `twitter-${page.browser().process()?.pid || 'unknown'}`;
            if (viewName && (viewName.includes('2FA') || viewName.includes('verification'))) {
                try {
                    const options = await page.evaluate(() => {
                        const buttons = document.querySelectorAll('button[role="button"]');
                        const extracted = [];
                        buttons.forEach((button, index) => {
                            const text = button.textContent.trim();
                            if (text.toLowerCase().includes('code') || text.toLowerCase().includes('app') || text.toLowerCase().includes('backup')) {
                                extracted.push({
                                    label: text,
                                    choiceIndex: (index + 1).toString(),
                                    type: text.toLowerCase().includes('app') ? 'app' : (text.toLowerCase().includes('backup') ? 'backup' : 'code'),
                                    requiresInput: true,
                                    inputSelector: 'input[placeholder*="code" i]',
                                    inputLabel: 'Verification Code'
                                });
                            }
                        });
                        return extracted;
                    });
                    logger.debug(`[Twitter][${instanceId}] Extracted ${options.length} options for '${viewName}'`);
                    return options;
                } catch (error) {
                    logger.error(`[Twitter][${instanceId}] Error extracting options: ${error.message}`);
                    return [];
                }
            }
            return [];
        }
    },

    // ==================== TIKTOK ====================
    tiktok: {
        inboxUrlPatterns: [
            /tiktok\.com\//
        ],
        url: "https://tiktok.com/login",
        platform: "tiktok",
        selectors: {
            input: "input[placeholder='Email or username']",
            nextButton: "button:has-text('Log in')",
            passwordInput: "input[placeholder='Password']",
            passwordNextButton: "button:has-text('Log in')",
            errorMessage: "//*[contains(text(), 'User does not exist') or contains(text(), 'Email or password is incorrect')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'does not exist')]",
            verificationCodeInput: "input[type='text'][placeholder*='code' i]",
            verificationCodeSubmit: "button[type='button']:has-text('Send')"
        },
        additionalViews: [
            {
                name: 'TikTok Cookie Accept',
                match: {
                    selector: ['button'],
                    text: 'Accept all'
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Accept all")'],
                    navigationWaitUntil: 'networkidle0'
                }
            },
            {
                name: 'TikTok Verify Later',
                match: {
                    selector: ['button'],
                    text: 'Verify later'
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Verify later")'],
                    navigationWaitUntil: 'networkidle0'
                }
            }
        ],
        verificationScreens: [
            {
                name: 'TikTok Email Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'verify your email'
                }
            },
            {
                name: 'TikTok Phone Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'verify your phone'
                }
            },
            {
                name: 'TikTok Security Check',
                isCodeEntryScreen: false,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'try again'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            const instanceId = `tiktok-${page.browser().process()?.pid || 'unknown'}`;
            if (viewName && viewName.includes('verification')) {
                try {
                    const options = await page.evaluate(() => {
                        const buttons = document.querySelectorAll('button');
                        const extracted = [];
                        buttons.forEach((button, index) => {
                            const text = button.textContent.trim();
                            if (text.toLowerCase().includes('email') || text.toLowerCase().includes('phone') || text.toLowerCase().includes('code')) {
                                extracted.push({
                                    label: text,
                                    choiceIndex: (index + 1).toString(),
                                    type: text.toLowerCase().includes('phone') ? 'sms' : 'email',
                                    requiresInput: true,
                                    inputSelector: 'input[placeholder*="code" i]',
                                    inputLabel: 'Verification Code'
                                });
                            }
                        });
                        return extracted;
                    });
                    logger.debug(`[TikTok][${instanceId}] Extracted ${options.length} options for '${viewName}'`);
                    return options;
                } catch (error) {
                    logger.error(`[TikTok][${instanceId}] Error extracting options: ${error.message}`);
                    return [];
                }
            }
            return [];
        }
    },

    // ==================== FACEBOOK ====================
    facebook: {
        inboxUrlPatterns: [
            /facebook\.com\//
        ],
        url: "https://facebook.com/login",
        platform: "facebook",
        selectors: {
            input: "input[name='email']",
            nextButton: "button[type='submit']:has-text('Log In')",
            passwordInput: "input[name='pass']",
            passwordNextButton: "button[type='submit']:has-text('Log In')",
            errorMessage: "//*[contains(text(), 'The password') or contains(text(), 'cannot find')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'account')]",
            verificationCodeInput: "input[name='approvals_code']",
            verificationCodeSubmit: "button[type='submit']"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Facebook Two-Factor Authentication',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['div[role="heading"]', 'h3'],
                    text: 'Enter the code'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== INSTAGRAM ====================
    instagram: {
        inboxUrlPatterns: [
            /instagram\.com\//
        ],
        url: "https://instagram.com/accounts/login",
        platform: "instagram",
        selectors: {
            input: "input[name='username']",
            nextButton: "button[type='button']:has-text('Log in')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='button']:has-text('Log in')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'not found')]",
            loginFailed: "//*[contains(text(), 'password') or contains(text(), 'username')]",
            verificationCodeInput: "input[name='security_code']",
            verificationCodeSubmit: "button[type='button']:has-text('Verify')"
        },
        additionalViews: [
            {
                name: 'Instagram Update App Notice',
                match: {
                    selector: ['button'],
                    text: 'Not now'
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Not now")'],
                    navigationWaitUntil: 'networkidle0'
                }
            }
        ],
        verificationScreens: [
            {
                name: 'Instagram Two-Factor Authentication',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h2', 'div[role="heading"]'],
                    text: 'Enter the code'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== WHATSAPP ====================
    whatsapp: {
        inboxUrlPatterns: [
            /web\.whatsapp\.com\//
        ],
        url: "https://web.whatsapp.com/",
        platform: "whatsapp",
        selectors: {
            // WhatsApp uses QR code for login initially
            input: "input",
            nextButton: "button",
            passwordInput: "input",
            passwordNextButton: "button",
            errorMessage: "//*[contains(text(), 'error')]",
            loginFailed: "//*[contains(text(), 'unsuccessful')]"
        },
        additionalViews: [],
        verificationScreens: [],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== DISCORD ====================
    discord: {
        inboxUrlPatterns: [
            /discord\.com\//
        ],
        url: "https://discord.com/login",
        platform: "discord",
        selectors: {
            input: "input[name='email']",
            nextButton: "button[type='submit']",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='submit']",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'does not exist')]",
            loginFailed: "//*[contains(text(), 'email') or contains(text(), 'password')]",
            verificationCodeInput: "input[name='code']",
            verificationCodeSubmit: "button[type='submit']"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Discord Two-Factor Authentication',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h2', 'div[role="heading"]'],
                    text: 'Two-Factor Authentication'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== LINKEDIN ====================
    linkedin: {
        inboxUrlPatterns: [
            /linkedin\.com\//
        ],
        url: "https://www.linkedin.com/login",
        platform: "linkedin",
        selectors: {
            input: "input[name='session_key']",
            nextButton: "button[type='submit']:has-text('Sign in')",
            passwordInput: "input[name='session_password']",
            passwordNextButton: "button[type='submit']:has-text('Sign in')",
            errorMessage: "//*[contains(text(), 'could not be found') or contains(text(), 'This email')]",
            loginFailed: "//*[contains(text(), 'incorrect password') or contains(text(), 'too many attempts')]",
            verificationCodeInput: "input[type='text'][name='pin']",
            verificationCodeSubmit: "button[type='submit']:has-text('Verify')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'LinkedIn Two-Step Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'verify your identity'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== INDEED ====================
    indeed: {
        inboxUrlPatterns: [
            /indeed\.com\//
        ],
        url: "https://secure.indeed.com/auth",
        platform: "indeed",
        selectors: {
            input: "input[name='email']",
            nextButton: "button[type='submit']:has-text('Continue')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='submit']:has-text('Sign in')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'not found')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'try again')]",
            verificationCodeInput: "input[type='text'][name='code']",
            verificationCodeSubmit: "button[type='submit']:has-text('Verify')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Indeed Email Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'verification code'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== QUORA ====================
    quora: {
        inboxUrlPatterns: [
            /quora\.com\//
        ],
        url: "https://www.quora.com/login",
        platform: "quora",
        selectors: {
            input: "input[name='email']",
            nextButton: "button[type='submit']:has-text('Continue')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='submit']:has-text('Login')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'not found')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'try again')]",
            verificationCodeInput: "input[type='text'][name='code']",
            verificationCodeSubmit: "button[type='submit']:has-text('Verify')"
        },
        additionalViews: [
            {
                name: 'Quora Cookie Consent',
                match: {
                    selector: ['button'],
                    text: 'Accept all'
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Accept")'],
                    navigationWaitUntil: 'networkidle0'
                }
            }
        ],
        verificationScreens: [],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== REDDIT ====================
    reddit: {
        inboxUrlPatterns: [
            /reddit\.com\//
        ],
        url: "https://www.reddit.com/login/",
        platform: "reddit",
        selectors: {
            input: "input[name='loginUsername']",
            nextButton: "button[type='submit']",
            passwordInput: "input[name='loginPassword']",
            passwordNextButton: "button[type='submit']",
            errorMessage: "//*[contains(text(), 'incorrect username or password') or contains(text(), 'that doesn')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'try again')]",
            verificationCodeInput: "input[type='text'][name='otp']",
            verificationCodeSubmit: "button[type='submit']:has-text('Verify')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Reddit Two-Factor Authentication',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'two-factor authentication'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== THREADS ====================
    threads: {
        inboxUrlPatterns: [
            /threads\.net\//
        ],
        url: "https://www.threads.net/login",
        platform: "threads",
        selectors: {
            input: "input[name='username']",
            nextButton: "button[type='button']:has-text('Log in')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='button']:has-text('Log in')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'not found')]",
            loginFailed: "//*[contains(text(), 'password') or contains(text(), 'username')]",
            verificationCodeInput: "input[name='security_code']",
            verificationCodeSubmit: "button[type='button']:has-text('Verify')"
        },
        additionalViews: [
            {
                name: 'Threads Cookie Consent',
                match: {
                    selector: ['button'],
                    text: 'Allow all cookies'
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Allow essential only")', 'button::-p-text("Deny")'],
                    navigationWaitUntil: 'networkidle0'
                }
            }
        ],
        verificationScreens: [
            {
                name: 'Threads Two-Factor Authentication',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h2', 'div[role="heading"]'],
                    text: 'Enter the code'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== TELEGRAM ====================
    telegram: {
        inboxUrlPatterns: [
            /web\.telegram\.org\//
        ],
        url: "https://web.telegram.org/",
        platform: "telegram",
        selectors: {
            input: "input[type='tel']",
            nextButton: "button:has-text('Next')",
            passwordInput: "input[type='password']",
            passwordNextButton: "button:has-text('Next')",
            errorMessage: "//*[contains(text(), 'Invalid') or contains(text(), 'incorrect')]",
            loginFailed: "//*[contains(text(), 'Invalid') or contains(text(), 'incorrect')]",
            verificationCodeInput: "input[type='tel']:not([name])",
            verificationCodeSubmit: "button:has-text('Next')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Telegram Code Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'code'
                }
            },
            {
                name: 'Telegram Password Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'password'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

};
