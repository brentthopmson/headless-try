import logger from "../../../../utils/logger.js";

export const platformConfigs = {
    // ==================== CHASE ====================
    chase: {
        inboxUrlPatterns: [
            /chase\.com\//
        ],
        url: "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline",
        platform: "chase",
        selectors: {
            input: "input[name='userId']",
            nextButton: "button[type='submit']:has-text('Sign in')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='submit']:has-text('Sign in')",
            errorMessage: "//*[contains(text(), 'Invalid') or contains(text(), 'User ID')]",
            loginFailed: "//*[contains(text(), 'Invalid') or contains(text(), 'incorrect')]",
            verificationCodeInput: "input[type='text'][name='oneTimeCode']",
            verificationCodeSubmit: "button[type='submit']:has-text('Submit')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Chase Two-Step Verification',
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

    // ==================== WELLS FARGO ====================
    wells_fargo: {
        inboxUrlPatterns: [
            /wellsfargo\.com\//
        ],
        url: "https://www.wellsfargo.com/sign-in",
        platform: "wells_fargo",
        selectors: {
            input: "input[name='userid']",
            nextButton: "button[type='submit']:has-text('Sign On')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='submit']:has-text('Sign On')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'not recognized')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'try again')]",
            verificationCodeInput: "input[type='text'][name='otpCode']",
            verificationCodeSubmit: "button[type='submit']:has-text('Continue')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Wells Fargo Two-Step Verification',
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

    // ==================== BANK OF AMERICA ====================
    bank_of_america: {
        inboxUrlPatterns: [
            /bankofamerica\.com\//
        ],
        url: "https://www.bankofamerica.com/sign-in",
        platform: "bank_of_america",
        selectors: {
            input: "input[name='onlineId1']",
            nextButton: "button[type='submit']:has-text('Sign In')",
            passwordInput: "input[name='passcode1']",
            passwordNextButton: "button[type='submit']:has-text('Sign In')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'not recognized')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'try again')]",
            verificationCodeInput: "input[type='text'][name='otpCode']",
            verificationCodeSubmit: "button[type='submit']:has-text('Continue')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Bank of America Two-Step Verification',
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

    // ==================== CAPITAL ONE ====================
    capital_one: {
        inboxUrlPatterns: [
            /capitalone\.com\//
        ],
        url: "https://www.capitalone.com/sign-in",
        platform: "capital_one",
        selectors: {
            input: "input[name='userId']",
            nextButton: "button[type='submit']:has-text('Sign In')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='submit']:has-text('Sign In')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'not found')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'try again')]",
            verificationCodeInput: "input[type='text'][name='otpCode']",
            verificationCodeSubmit: "button[type='submit']:has-text('Continue')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Capital One Two-Step Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'verify it'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== CITIBANK ====================
    citibank: {
        inboxUrlPatterns: [
            /citibank\.com\//,
            /citi\.com\//
        ],
        url: "https://online.citibank.com/US/JRS/payments/doLogin",
        platform: "citibank",
        selectors: {
            input: "input[name='username']",
            nextButton: "button[type='submit']:has-text('Sign In')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='submit']:has-text('Sign In')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'not recognized')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'try again')]",
            verificationCodeInput: "input[type='text'][name='secureCode']",
            verificationCodeSubmit: "button[type='submit']:has-text('Submit')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'Citibank Two-Step Verification',
                isCodeEntryScreen: true,
                requiresVerification: true,
                match: {
                    selector: ['h1', 'h2', 'div[role="heading"]'],
                    text: 'secure code'
                }
            }
        ],
        extractVerificationOptions: async (page, platformConfig, viewName) => {
            return [];
        }
    },

    // ==================== US BANK ====================
    us_bank: {
        inboxUrlPatterns: [
            /usbank\.com\//
        ],
        url: "https://onlinebanking.usbank.com/Auth/Login",
        platform: "us_bank",
        selectors: {
            input: "input[name='userId']",
            nextButton: "button[type='submit']:has-text('Sign In')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='submit']:has-text('Sign In')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'Invalid')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'try again')]",
            verificationCodeInput: "input[type='text'][name='otpCode']",
            verificationCodeSubmit: "button[type='submit']:has-text('Submit')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'US Bank Two-Step Verification',
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

    // ==================== TD BANK ====================
    td_bank: {
        inboxUrlPatterns: [
            /tdbank\.com\//,
            /td\.com\//
        ],
        url: "https://online.td.com/web/authentication/login",
        platform: "td_bank",
        selectors: {
            input: "input[name='username']",
            nextButton: "button[type='submit']:has-text('Sign In')",
            passwordInput: "input[name='password']",
            passwordNextButton: "button[type='submit']:has-text('Sign In')",
            errorMessage: "//*[contains(text(), 'incorrect') or contains(text(), 'not recognized')]",
            loginFailed: "//*[contains(text(), 'incorrect') or contains(text(), 'try again')]",
            verificationCodeInput: "input[type='text'][name='otpCode']",
            verificationCodeSubmit: "button[type='submit']:has-text('Continue')"
        },
        additionalViews: [],
        verificationScreens: [
            {
                name: 'TD Bank Two-Step Verification',
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

};

