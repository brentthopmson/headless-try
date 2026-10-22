export const discord = {
    platform: "discord",
    urls: {
        profile: null,
        notifications: null,
        messages: "https://discord.com/channels/@me",
    },
    capabilities: { follow: false, unfollow: false, like: false, comment: false, notifications: false, inbox: true, newDm: true },
    selectors: {
        conversationItem: ["a[href*='/channels/@me/']", "[data-list-item-id^='private-channels']"],
        conversationName: "span",
        conversationSnippet: "span",
        messageInput: ["div[role='textbox'][contenteditable='true']", "[aria-label*='Message']"],
        messageSend: null,
        outgoingMessage: ["[class*='messageContent']", "[id^='message-content']"],
        incomingMessage: ["[class*='messageContent']", "[id^='message-content']"],
        newMessageButton: ["[aria-label='Create DM']", "[aria-label='Friends']"],
        recipientInput: ["input[placeholder*='Search' i]", "[aria-label='Search']"],
        recipientResult: ["[role='option']", "[class*='user']"],
        loggedOut: ["[class*='authBox']", "input[name='email']"],
        cookieBanner: [],
    },
    labels: { send: /send/i },
};
