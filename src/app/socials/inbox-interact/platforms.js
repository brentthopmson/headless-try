import logger from "../../../utils/logger.js";
import MultiProviderAI from "../../../utils/multiProviderAI.js";

const ai = new MultiProviderAI();

export const platformConfigs = {
    // ==================== TWITTER / X ====================
    twitter: {
        platform: "twitter",
        homeUrl: "https://x.com/home",
        messagesUrl: "https://x.com/messages",
        profileUrl: "https://x.com",

        selectors: {
            messagesNav: "a[aria-label='Messages']",
            dmPane: "div[data-testid='DMDrawer']",
            messageThread: "div[data-testid='messageEntry']",
            messageInput: "div[role='textbox']",
            sendButton: "button:has-text('Send')",
            newMessageButton: "button[aria-label='New message']",
            recipientInput: "input[placeholder*='Search']",
            recipientOption: "div[data-testid='UserCell']",
            conversationList: "div[aria-label='Messages pane']",
            conversationItem: "div[data-testid='conversation']",
            messageText: "div[data-testid='messageText']",
            closeModal: "button[aria-label='Close']",
        },

        timing: {
            minDelayBetweenActions: 2000,
            maxDelayBetweenActions: 5000,
            messageCheckDelay: 3000,
            navigationTimeout: 15000,
        },

        workflows: {
            readInbox: {
                name: "Read inbox messages",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "inboxContent" },
                    { action: "scroll", distance: 400 },
                    { action: "pause", duration: 1500 },
                ],
                extract: "conversations"
            },

            sendMessage: {
                name: "Send a direct message",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.newMessageButton}" },
                    { action: "pause", duration: 1500 },
                    { action: "fillText", selector: "${selectors.recipientInput}", value: "${keyword}" },
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

            checkConversation: {
                name: "Check latest conversation for new messages",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.conversationItem}" },
                    { action: "pause", duration: 2000 },
                    { action: "capturePageContent", captureName: "conversationContent" },
                ],
                extract: "messages"
            },
        },

        aiPrompts: {
            generateColdMessage: `Generate a friendly, personalized cold message for a social media platform. The message should:
- Be 1-2 sentences maximum
- Reference something relevant to the recipient
- Be conversational and genuine (not salesy)
- Not be generic or spammy
- Feel like a real person reaching out
{{socialStrategyPrompt}}
Recipient context: "{context}"
YOUR MESSAGE:`,
        },

        extractors: {
            conversations: {
                selector: "div[data-testid='messageEntry']",
                parseFunction: `(entries) => {
                    const chats = [];
                    entries.forEach(entry => {
                        try {
                            const nameEl = entry.querySelector('span');
                            const textEl = entry.querySelector('div[data-testid=\\'messageText\\']');
                            if (nameEl) chats.push({
                                name: nameEl.textContent.trim(),
                                lastMessage: textEl?.textContent?.trim() || '',
                                unread: entry.querySelector('[aria-label*=\\'unread\\']') !== null,
                            });
                        } catch(e) {}
                    });
                    return chats;
                }`
            },
            messages: {
                selector: "div[data-testid='messageText']",
                parseFunction: `(items) => {
                    const msgs = [];
                    items.forEach(item => msgs.push({ text: item.textContent.trim() }));
                    return msgs;
                }`
            },
        },

        interactionRules: {
            maxMessagesPerConversation: 1,
            maxNewConversationsPerSession: 5,
            allowColdMessages: true,
        }
    },

    // ==================== TIKTOK ====================
    tiktok: {
        platform: "tiktok",
        homeUrl: "https://www.tiktok.com/foryou",
        messagesUrl: "https://www.tiktok.com/messages",
        profileUrl: "https://www.tiktok.com",

        selectors: {
            messagesNav: "a[data-e2e='nav-messages']",
            conversationItem: "div[data-e2e='conversation-item']",
            messageInput: "div[contenteditable='true']",
            sendButton: "button:has-text('Send')",
            newMessageButton: "button:has-text('New message')",
            recipientInput: "input[placeholder*='search']",
            messageText: "div[data-e2e='message-text']",
            backButton: "button[aria-label='Back']",
        },

        timing: {
            minDelayBetweenActions: 1500,
            maxDelayBetweenActions: 4000,
            messageCheckDelay: 2500,
            navigationTimeout: 12000,
        },

        workflows: {
            readInbox: {
                name: "Read TikTok inbox messages",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "inboxContent" },
                ],
                extract: "conversations"
            },

            sendMessage: {
                name: "Send a TikTok message",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.newMessageButton}" },
                    { action: "pause", duration: 1500 },
                    { action: "fillText", selector: "${selectors.recipientInput}", value: "${keyword}" },
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

        aiPrompts: {
            generateColdMessage: `Generate a short, friendly message for TikTok. 
{{socialStrategyPrompt}}
Recipient: "{context}"
YOUR MESSAGE (1-2 sentences):`,
        },

        extractors: {
            conversations: {
                selector: "div[data-e2e='conversation-item']",
                parseFunction: `(items) => {
                    const chats = [];
                    items.forEach(item => {
                        try {
                            const nameEl = item.querySelector('h3');
                            if (nameEl) chats.push({ name: nameEl.textContent.trim() });
                        } catch(e) {}
                    });
                    return chats;
                }`
            },
        },

        interactionRules: {
            maxMessagesPerConversation: 1,
            maxNewConversationsPerSession: 3,
            allowColdMessages: true,
        }
    },

    // ==================== FACEBOOK MESSENGER ====================
    facebook: {
        platform: "facebook",
        homeUrl: "https://www.facebook.com",
        messagesUrl: "https://www.facebook.com/messages",
        profileUrl: "https://www.facebook.com",

        selectors: {
            messagesNav: "a[aria-label*='Messenger']",
            conversationItem: "div[role='row'][aria-label*='Conversation']",
            messageInput: "div[aria-label*='Message']",
            sendButton: "button[aria-label='Press Enter to send']",
            newMessageButton: "button[aria-label='New message']",
            recipientInput: "input[aria-label*='Search']",
            messageText: "div[data-testid='message-text']",
            inboxPane: "div[aria-label='Messages']",
        },

        timing: {
            minDelayBetweenActions: 3000,
            maxDelayBetweenActions: 6000,
            messageCheckDelay: 3500,
            navigationTimeout: 20000,
        },

        workflows: {
            readInbox: {
                name: "Read Facebook Messenger inbox",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "inboxContent" },
                ],
                extract: "conversations"
            },
            sendMessage: {
                name: "Send a Facebook message",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "click", selector: "${selectors.newMessageButton}" },
                    { action: "pause", duration: 2000 },
                    { action: "fillText", selector: "${selectors.recipientInput}", value: "${keyword}" },
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

        aiPrompts: {
            generateColdMessage: `Generate a short, friendly Facebook message. Keep it natural and conversational.
{{socialStrategyPrompt}}
Recipient: "{context}"
YOUR MESSAGE:`,
        },

        extractors: {
            conversations: {
                selector: "div[role='row'][aria-label*='Conversation']",
                parseFunction: `(items) => {
                    const chats = [];
                    items.forEach(item => {
                        try {
                            const nameEl = item.querySelector('span');
                            if (nameEl) chats.push({ name: nameEl.textContent.trim() });
                        } catch(e) {}
                    });
                    return chats;
                }`
            },
        },

        interactionRules: {
            maxMessagesPerConversation: 1,
            maxNewConversationsPerSession: 5,
            allowColdMessages: true,
        }
    },

    // ==================== INSTAGRAM DM ====================
    instagram: {
        platform: "instagram",
        homeUrl: "https://www.instagram.com",
        messagesUrl: "https://www.instagram.com/direct/inbox",
        profileUrl: "https://www.instagram.com",

        selectors: {
            messagesNav: "a[href*='direct']",
            conversationItem: "div[role='link'][class*='conversation']",
            messageInput: "textarea[aria-label*='Message']",
            sendButton: "button:has-text('Send')",
            newMessageButton: "button[aria-label='New message']",
            recipientInput: "input[aria-label*='Search']",
            messageText: "div[class*='message-text']",
        },

        timing: {
            minDelayBetweenActions: 3000,
            maxDelayBetweenActions: 6000,
            messageCheckDelay: 3000,
            navigationTimeout: 20000,
        },

        workflows: {
            readInbox: {
                name: "Read Instagram DMs",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "inboxContent" },
                ],
                extract: "conversations"
            },
            sendMessage: {
                name: "Send an Instagram DM",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2500 },
                    { action: "click", selector: "${selectors.newMessageButton}" },
                    { action: "pause", duration: 2000 },
                    { action: "fillText", selector: "${selectors.recipientInput}", value: "${keyword}" },
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

        aiPrompts: {
            generateColdMessage: `Write a casual Instagram DM. Very short and friendly.
{{socialStrategyPrompt}}
Recipient: "{context}"
YOUR MESSAGE:`,
        },

        extractors: {
            conversations: {
                selector: "div[role='link'][class*='conversation']",
                parseFunction: `(items) => {
                    const chats = [];
                    items.forEach(item => {
                        try {
                            const nameEl = item.querySelector('span');
                            if (nameEl) chats.push({ name: nameEl.textContent.trim() });
                        } catch(e) {}
                    });
                    return chats;
                }`
            },
        },

        interactionRules: {
            maxMessagesPerConversation: 1,
            maxNewConversationsPerSession: 3,
            allowColdMessages: true,
        }
    },

    // ==================== WHATSAPP ====================
    whatsapp: {
        platform: "whatsapp",
        homeUrl: "https://web.whatsapp.com",
        messagesUrl: "https://web.whatsapp.com",

        selectors: {
            conversationItem: "div[role='row']",
            messageInput: "div[contenteditable='true'][data-testid='conversation-compose-box-input']",
            sendButton: "button[data-testid='compose-btn-send']",
            newChatButton: "button[aria-label*='New chat']",
            recipientInput: "input[aria-label*='Search']",
            messageText: "div[data-testid='message-text']",
            chatPane: "div[data-testid='conversation-panel-messages']",
        },

        timing: {
            minDelayBetweenActions: 4000,
            maxDelayBetweenActions: 7000,
            messageCheckDelay: 4000,
            navigationTimeout: 30000,
            qrWaitTimeout: 60000,
        },

        workflows: {
            readInbox: {
                name: "Read WhatsApp conversations",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 5000 },
                    { action: "capturePageContent", captureName: "inboxContent" },
                    { action: "scroll", distance: 300 },
                    { action: "pause", duration: 2000 },
                ],
                extract: "conversations"
            },
            sendMessage: {
                name: "Send a WhatsApp message",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 5000 },
                    { action: "click", selector: "${selectors.newChatButton}" },
                    { action: "pause", duration: 2000 },
                    { action: "fillText", selector: "${selectors.recipientInput}", value: "${keyword}" },
                    { action: "pause", duration: 3000 },
                    { action: "click", selector: "${selectors.conversationItem}" },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.messageInput}" },
                    { action: "fillText", selector: "${selectors.messageInput}", value: "${messageText}" },
                    { action: "click", selector: "${selectors.sendButton}" },
                    { action: "pause", duration: 3000 },
                ],
            },
            checkConversation: {
                name: "Check latest WhatsApp conversation",
                steps: [
                    { action: "navigate", url: "${messagesUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 5000 },
                    { action: "click", selector: "${selectors.conversationItem}" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "conversationContent" },
                ],
                extract: "messages"
            },
        },

        aiPrompts: {
            generateColdMessage: `Generate a short, friendly WhatsApp message. Very casual and conversational.
{{socialStrategyPrompt}}
Recipient: "{context}"
YOUR MESSAGE:`,
        },

        extractors: {
            conversations: {
                selector: "div[role='row']",
                parseFunction: `(items) => {
                    const chats = [];
                    items.forEach(item => {
                        try {
                            const nameEl = item.querySelector('span[data-testid=\\'conversation-info-header\\']');
                            if (nameEl) chats.push({ name: nameEl.textContent.trim() });
                        } catch(e) {}
                    });
                    return chats;
                }`
            },
            messages: {
                selector: "div[data-testid='message-text']",
                parseFunction: `(items) => {
                    const msgs = [];
                    items.forEach(item => msgs.push({ text: item.textContent.trim() }));
                    return msgs;
                }`
            },
        },

        interactionRules: {
            maxMessagesPerConversation: 1,
            maxNewConversationsPerSession: 3,
            allowColdMessages: true,
        }
    },
};

export function getPlatformConfig(platform) {
    const config = platformConfigs[platform];
    if (!config) throw new Error(`Platform config not found: ${platform}`);
    return config;
}

export function getWorkflow(platform, operation) {
    const config = getPlatformConfig(platform);
    if (!config.workflows) throw new Error(`No workflows defined for platform: ${platform}`);
    const workflow = config.workflows[operation];
    if (!workflow) throw new Error(`No workflow '${operation}' defined for platform: ${platform}`);
    return workflow;
}

export function getExtractor(platform, extractorName) {
    const config = getPlatformConfig(platform);
    if (!config.extractors) return null;
    return config.extractors[extractorName] || null;
}

export { ai as MultiProviderAI };
