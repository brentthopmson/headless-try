import logger from "../../../utils/logger.js";

export const platformConfigs = {

    // ==================== TWITTER / X ====================
    twitter: {
        platform: "twitter",
        messagesUrl: "https://x.com/messages",

        selectors: {
            newMessageButton: "button[aria-label='New message']",
            recipientInput: "input[placeholder*='Search']",
            recipientOption: "div[data-testid='UserCell']",
            messageInput: "div[role='textbox']",
            sendButton: "button:has-text('Send')",
            closeModal: "button[aria-label='Close']",
            errorToast: "div[data-testid='toast']",
        },

        timing: {
            minDelay: 2000,
            maxDelay: 4000,
            navigationTimeout: 15000,
        },

        workflow: {
            name: "Send Twitter DM",
            steps: [
                { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                { action: "pause", duration: 2000 },
                { action: "click", selector: "${selectors.newMessageButton}" },
                { action: "pause", duration: 1500 },
                { action: "fillText", selector: "${selectors.recipientInput}", value: "${recipient}" },
                { action: "pause", duration: 2000 },
                { action: "click", selector: "${selectors.recipientOption}" },
                { action: "pause", duration: 1000 },
                { action: "click", selector: "${selectors.messageInput}" },
                { action: "fillText", selector: "${selectors.messageInput}", value: "${messageText}" },
                { action: "click", selector: "${selectors.sendButton}" },
                { action: "pause", duration: 2000 },
                { action: "click", selector: "${selectors.closeModal}" },
            ],
        },
    },

    // ==================== TIKTOK ====================
    tiktok: {
        platform: "tiktok",
        messagesUrl: "https://www.tiktok.com/messages",

        selectors: {
            newMessageButton: "button:has-text('New message')",
            recipientInput: "input[placeholder*='search']",
            conversationItem: "div[data-e2e='conversation-item']",
            messageInput: "div[contenteditable='true']",
            sendButton: "button:has-text('Send')",
            backButton: "button[aria-label='Back']",
        },

        timing: {
            minDelay: 1500,
            maxDelay: 3500,
            navigationTimeout: 12000,
        },

        workflow: {
            name: "Send TikTok message",
            steps: [
                { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                { action: "pause", duration: 2000 },
                { action: "click", selector: "${selectors.newMessageButton}" },
                { action: "pause", duration: 1500 },
                { action: "fillText", selector: "${selectors.recipientInput}", value: "${recipient}" },
                { action: "pause", duration: 2000 },
                { action: "click", selector: "${selectors.conversationItem}" },
                { action: "pause", duration: 1000 },
                { action: "click", selector: "${selectors.messageInput}" },
                { action: "fillText", selector: "${selectors.messageInput}", value: "${messageText}" },
                { action: "click", selector: "${selectors.sendButton}" },
                { action: "pause", duration: 2000 },
            ],
        },
    },

    // ==================== FACEBOOK MESSENGER ====================
    facebook: {
        platform: "facebook",
        messagesUrl: "https://www.facebook.com/messages",

        selectors: {
            newMessageButton: "button[aria-label='New message']",
            recipientInput: "input[aria-label*='Search']",
            conversationItem: "div[role='row'][aria-label*='Conversation']",
            messageInput: "div[aria-label*='Message']",
            sendButton: "button[aria-label='Press Enter to send']",
        },

        timing: {
            minDelay: 3000,
            maxDelay: 5000,
            navigationTimeout: 20000,
        },

        workflow: {
            name: "Send Facebook message",
            steps: [
                { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                { action: "pause", duration: 3000 },
                { action: "click", selector: "${selectors.newMessageButton}" },
                { action: "pause", duration: 2000 },
                { action: "fillText", selector: "${selectors.recipientInput}", value: "${recipient}" },
                { action: "pause", duration: 2500 },
                { action: "click", selector: "${selectors.conversationItem}" },
                { action: "pause", duration: 1500 },
                { action: "click", selector: "${selectors.messageInput}" },
                { action: "fillText", selector: "${selectors.messageInput}", value: "${messageText}" },
                { action: "click", selector: "${selectors.sendButton}" },
                { action: "pause", duration: 2000 },
            ],
        },
    },

    // ==================== INSTAGRAM DM ====================
    instagram: {
        platform: "instagram",
        messagesUrl: "https://www.instagram.com/direct/inbox",

        selectors: {
            newMessageButton: "button[aria-label='New message']",
            recipientInput: "input[aria-label*='Search']",
            conversationItem: "div[role='link'][class*='conversation']",
            messageInput: "textarea[aria-label*='Message']",
            sendButton: "button:has-text('Send')",
        },

        timing: {
            minDelay: 3000,
            maxDelay: 5000,
            navigationTimeout: 20000,
        },

        workflow: {
            name: "Send Instagram DM",
            steps: [
                { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                { action: "pause", duration: 2500 },
                { action: "click", selector: "${selectors.newMessageButton}" },
                { action: "pause", duration: 2000 },
                { action: "fillText", selector: "${selectors.recipientInput}", value: "${recipient}" },
                { action: "pause", duration: 2000 },
                { action: "click", selector: "${selectors.conversationItem}" },
                { action: "pause", duration: 1500 },
                { action: "click", selector: "${selectors.messageInput}" },
                { action: "fillText", selector: "${selectors.messageInput}", value: "${messageText}" },
                { action: "click", selector: "${selectors.sendButton}" },
                { action: "pause", duration: 2000 },
            ],
        },
    },

    // ==================== WHATSAPP ====================
    whatsapp: {
        platform: "whatsapp",
        messagesUrl: "https://web.whatsapp.com",

        selectors: {
            newChatButton: "button[aria-label*='New chat']",
            recipientInput: "input[aria-label*='Search']",
            conversationItem: "div[role='row']",
            messageInput: "div[contenteditable='true'][data-testid='conversation-compose-box-input']",
            sendButton: "button[data-testid='compose-btn-send']",
        },

        timing: {
            minDelay: 4000,
            maxDelay: 7000,
            navigationTimeout: 30000,
            qrWaitTimeout: 60000,
        },

        workflow: {
            name: "Send WhatsApp message",
            steps: [
                { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                { action: "pause", duration: 5000 },
                { action: "click", selector: "${selectors.newChatButton}" },
                { action: "pause", duration: 2000 },
                { action: "fillText", selector: "${selectors.recipientInput}", value: "${recipient}" },
                { action: "pause", duration: 3000 },
                { action: "click", selector: "${selectors.conversationItem}" },
                { action: "pause", duration: 2000 },
                { action: "click", selector: "${selectors.messageInput}" },
                { action: "fillText", selector: "${selectors.messageInput}", value: "${messageText}" },
                { action: "click", selector: "${selectors.sendButton}" },
                { action: "pause", duration: 3000 },
            ],
        },
    },

    // ==================== DISCORD ====================
    discord: {
        platform: "discord",
        messagesUrl: "https://discord.com/channels/@me",

        selectors: {
            newDmButton: "button[aria-label*='Add']",
            recipientInput: "input[role='combobox']",
            recipientOption: "div[role='option']",
            messageInput: "div[role='textbox'][aria-label*='Message']",
            sendButton: "button[aria-label*='Send']",
        },

        timing: {
            minDelay: 2000,
            maxDelay: 4000,
            navigationTimeout: 15000,
        },

        workflow: {
            name: "Send Discord DM",
            steps: [
                { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                { action: "pause", duration: 3000 },
                { action: "click", selector: "${selectors.newDmButton}" },
                { action: "pause", duration: 1500 },
                { action: "fillText", selector: "${selectors.recipientInput}", value: "${recipient}" },
                { action: "pause", duration: 2000 },
                { action: "click", selector: "${selectors.recipientOption}" },
                { action: "pause", duration: 1000 },
                { action: "click", selector: "${selectors.messageInput}" },
                { action: "fillText", selector: "${selectors.messageInput}", value: "${messageText}" },
                { action: "click", selector: "${selectors.sendButton}" },
                { action: "pause", duration: 2000 },
            ],
        },
    },
};

export function getPlatformConfig(platform) {
    const config = platformConfigs[platform];
    if (!config) throw new Error(`Platform config not found: ${platform}`);
    return config;
}

export function getWorkflow(platform) {
    const config = getPlatformConfig(platform);
    if (!config.workflow) throw new Error(`No workflow defined for platform: ${platform}`);
    return config.workflow;
}

export function getSelectors(platform) {
    const config = getPlatformConfig(platform);
    return config.selectors || {};
}

export function getTiming(platform) {
    const config = getPlatformConfig(platform);
    return config.timing || {};
}
