import logger from "../../../../utils/logger.js";
import tiktokHelper from "./platformHelper/tiktok.js";

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
        // (?!login) — /login/qrcode must NOT count as inbox, otherwise the
        // WAITINGCODE loop falsely completes (and checkVerification's isInbox
        // fallback masks a missing verificationScreens match).
        inboxUrlPatterns: [
            /tiktok\.com\/(?!login)/
        ],
        url: "https://tiktok.com/login",
        platform: "tiktok",
        // Per-method entry URLs — used to open 3 warm tabs at row start so
        // method switches activate an already-loaded tab instead of navigating.
        loginMethods: {
            qr:    { url: "https://www.tiktok.com/login/qrcode" },
            email: { url: "https://www.tiktok.com/login/phone-or-email/email" },
            phone: { url: "https://www.tiktok.com/login/phone-or-email/phone" }
        },
        // QR login capture config (platformHelper.runQrLogin).
        qr: {
            // Element candidates checked in order: TikTok's QR wrapper
            // (data-e2e="qr-code") first, then generic canvas/QR img, then
            // element screenshot fallback.
            selectors: ["div[data-e2e='qr-code'] canvas", "div[data-e2e='qr-code'] img", "canvas", "img[src*='qr' i]", "div[class*='qr' i] canvas", "div[class*='qr' i] img"],
            // Success = URL left /login (TikTok redirects home after scan) AND session cookie/inbox.
            successUrlPattern: /tiktok\.com\/(?!login)/,
            timeoutMs: 8 * 60 * 1000,   // QR wait ceiling (template polls 10 min, then shows credential screen)
            recaptureMs: 15000           // TikTok rotates the QR image every ~30-60s; re-capture faster so the template never shows a stale/expired code
        },
        selectors: {
            // Grounded in live DOM (/login/phone-or-email/email, 2026-10-01):
            // username + password inputs visible on load; submit is
            // <button data-e2e="login-button" type="submit">Log in</button>.
            input: "input[placeholder='Email or username']",
            nextButton: "[data-e2e='login-button']",
            // Post-QR "Enter password" challenge modal (pc-password-container-*)
            // has NO placeholder — attribute-match placeholder fails there.
            // type=password covers both the modal and the email/phone login form.
            passwordInput: "input[type='password']",
            // E-c: challenge-modal Next FIRST — the post-QR password modal and
            // the credential form can be in the DOM at once (the form's
            // login-button sits behind the overlay and still passes
            // waitForSelector's visibility check), so the specific modal
            // button must win the tie; route.js probes rendered+enabled state
            // before clicking, so the form path never waits on the modal.
            passwordNextButton: ["[class*='pc-password-next-btn'] button", "[data-e2e='login-button']"],
            errorMessage: "//*[contains(@class,'tux-form-item-footer--error') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'user does not exist') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'email or password is incorrect') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'maximum number of attempts')]",
            loginFailed: "//*[contains(@class,'tux-form-item-footer--error') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'incorrect') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'does not exist') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'attempts remaining') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'maximum number of attempts')]",
            // Phone tab (/login/phone-or-email/phone): phone input
            // (name=mobile), [data-e2e="send-code-button"] "Send code",
            // 6-digit code input rendered on the same page.
            phoneInput: "input[placeholder='Phone number']",
            sendCodeButton: "[data-e2e='send-code-button']",
            verificationCodeInput: "input[placeholder='Enter 6-digit code']",
            verificationCodeSubmit: "[data-e2e='login-button']",
            // Post-QR "Verify identity" OTP modal: submit is the disabled-until-filled
            // "Next" button (tux redesign: data-testid='tux-web-button'), NOT login-button.
            otpCodeSubmit: "button[data-testid='tux-web-button']:has-text('Next')"
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
                    // E-d: domcontentloaded — the cookie banner is an in-page
                    // state change; networkidle0 on TikTok (open analytics
                    // sockets) never fired and burned the full 15s wait.
                    navigationWaitUntil: 'domcontentloaded'
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
                    // E-d: same in-page action as cookie accept — see above.
                    navigationWaitUntil: 'domcontentloaded'
                }
            }
        ],
        verificationScreens: [
            // OTP-first: the OTP h1 text "Verify identity" never contains the
            // choice heading, so ordering is safe and keeps type='code' priority.
            {
                name: 'TikTok Identity OTP',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1[class*="pc-email-otp-title"]', 'h1[data-testid="tux-web-text"]', 'h1'],
                    text: 'Verify identity'
                }
            },
            {
                name: 'TikTok Identity Challenge',
                isVerificationChoiceScreen: true,
                requiresVerification: true,
                match: {
                    // The modal heading is not guaranteed to be an h1 (and the
                    // QR page's own h1 precedes it in DOM order) — enumerate
                    // heading shapes; matchVerificationView checks ALL matches.
                    selector: ['h1[data-testid="tux-web-text"]', 'h1', 'h2', 'div[role="heading"]', '[data-testid="tux-web-text"]'],
                    text: "Verify it's really you"
                }
            },
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
            // Post-QR challenge choice modal: rows are div[class*="pc-home-item"].
            // The substring selector also matches wrapper/title divs, so the
            // browser side only gathers raw texts — filtering, dedupe and label
            // building run in buildTikTokChallengeOptions (tiktok.js, jest-tested).
            // No viewName gate — the extractor is only invoked for choice screens.
            try {
                const rawTexts = await page.evaluate(() => Array.from(document.querySelectorAll('div[class*="pc-home-item"]'))
                    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()));
                const options = tiktokHelper.buildTikTokChallengeOptions(rawTexts);
                logger.debug(`[TikTok][${instanceId}] Extracted ${options.length} options for '${viewName}'`);
                return options;
            } catch (error) {
                logger.error(`[TikTok][${instanceId}] Error extracting options: ${error.message}`);
                return [];
            }
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

    // ==================== YOUTUBE (Google account) ====================
    youtube: {
        inboxUrlPatterns: [
            /youtube\.com\//
        ],
        url: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F",
        platform: "youtube",
        selectors: {
            input: "input[type='email']",
            nextButton: "#identifierNext",
            passwordInput: "input[type='password']",
            passwordNextButton: "#passwordNext",
            errorMessage: '//*[contains(text(), "Enter a valid email") or contains(text(), "Couldn") or contains(text(), "Find your Google Account")]',
            loginFailed: '//*[contains(text(), "Wrong password") or contains(text(), "incorrect password") or contains(text(), "password you entered")]',
            verificationCodeInput: "input[autocomplete='one-time-code'], input[type='tel'], input[name='totp']",
            verificationCodeSubmit: "#totpNext, #confirm, button::-p-text('Next')"
        },
        additionalViews: [
            {
                name: 'Google Consent',
                match: {
                    selector: ['button', 'div[role="button"]'],
                    text: 'Before you continue'
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Accept all")', 'button::-p-text("Reject all")', 'button::-p-text("I agree")'],
                    navigationWaitUntil: 'networkidle0'
                }
            },
            {
                name: 'Google Recovery Prompt',
                match: {
                    selector: ['h1', 'span'],
                    text: "Don't add this number"
                },
                action: {
                    type: 'click',
                    selector: ['button::-p-text("Not now")', 'button::-p-text("Confirm")'],
                    navigationWaitUntil: 'networkidle0'
                }
            }
        ],
        verificationScreens: [
            {
                name: 'Google 2-Step Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'span'],
                    text: '2-Step Verification'
                }
            },
            {
                name: 'Google Phone Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'span'],
                    text: 'verify your phone number'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

};
