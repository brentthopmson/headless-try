export const whatsapp = {
    platform: "whatsapp",
    urls: {
        profile: null,
        notifications: null,
        messages: "https://web.whatsapp.com/",
    },
    capabilities: { follow: false, unfollow: false, like: false, comment: false, notifications: false, inbox: true, newDm: true },
    selectors: {
        conversationItem: ["div[role='listitem']", "[data-testid='cell-frame-container']"],
        conversationName: "span[title]",
        conversationSnippet: "div[role='listitem'] span",
        messageInput: ["footer div[contenteditable='true']", "div[contenteditable='true'][data-tab='10']"],
        messageSend: ["button[data-testid='send']", "span[data-testid='send']"],
        outgoingMessage: ["div.message-out", "[data-testid='msg-out']"],
        incomingMessage: ["div.message-in", "[data-testid='msg-in']"],
        newMessageButton: ["[data-testid='chat']", "[aria-label='New chat']"],
        recipientInput: ["div[contenteditable='true'][data-tab='3']", "input[placeholder*='Search' i]"],
        recipientResult: ["div[role='listitem']", "[data-testid='cell-frame-container']"],
        loggedOut: ["canvas[aria-label*='Scan']", "[data-testid='qrcode']"],
        cookieBanner: [],
    },
    labels: { send: /send/i },
};
