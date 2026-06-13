import MultiProviderAI from "../../../utils/multiProviderAI.js";

const ai = new MultiProviderAI();

export const platformConfigs = {
    // ==================== TWITTER / X ====================
    twitter: {
        platform: "twitter",
        homeUrl: "https://x.com/home",
        notificationsUrl: "https://x.com/notifications",

        selectors: {
            notificationsNav: "a[aria-label='Notifications']",
            notificationItem: "div[data-testid='notification']",
            notificationIcon: "div[data-testid='icon']",
            likeButton: "button[aria-label*='like']",
            replyButton: "button[aria-label*='reply']",
            followButton: "button[aria-label*='Follow']",
            unfollowButton: "button[aria-label*='Unfollow']",
            scrollContainer: "main [role='region']",
        },

        timing: {
            minDelayBetweenActions: 2000,
            maxDelayBetweenActions: 4000,
            notificationLoadDelay: 2500,
            navigationTimeout: 15000,
        },

        workflows: {
            readNotifications: {
                name: "Read notification feed",
                steps: [
                    { action: "navigate", url: "${notificationsUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "notificationFeed" },
                    { action: "scroll", distance: 500 },
                    { action: "pause", duration: 1500 },
                ],
                extract: "notifications"
            },

            engageWithNotifications: {
                name: "Like and engage with notifications",
                steps: [
                    { action: "navigate", url: "${notificationsUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "likeRandomNotifications", maxCount: 3 },
                    { action: "pause", duration: 1500 },
                    { action: "scroll", distance: 400 },
                    { action: "pause", duration: 1000 },
                    { action: "likeRandomNotifications", maxCount: 2 },
                ],
            },

            followBack: {
                name: "Follow back users who engaged",
                steps: [
                    { action: "navigate", url: "${notificationsUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "notificationFeed" },
                ],
                extract: "newFollowers"
            },
        },

        aiPrompts: {
            analyzeNotification: "Based on this notification, is it worth engaging with? Consider: relevance, engagement potential, authenticity. Respond with ONLY: yes or no",
        },

        extractors: {
            notifications: {
                selector: "div[data-testid='notification']",
                parseFunction: `(items) => {
                    const notifs = [];
                    items.forEach(item => {
                        try {
                            const textEl = item.querySelector('span');
                            notifs.push({
                                text: textEl?.textContent?.trim() || '',
                                type: item.querySelector('[data-testid=\\'icon\\']') ? 'engagement' : 'notification',
                            });
                        } catch(e) {}
                    });
                    return notifs;
                }`
            },
            newFollowers: {
                selector: "div[data-testid='notification']",
                parseFunction: `(items) => {
                    const users = [];
                    items.forEach(item => {
                        const text = item.textContent || '';
                        if (text.includes('followed you')) {
                            const nameEl = item.querySelector('a[role=link]');
                            if (nameEl) users.push({ username: nameEl.textContent.trim() });
                        }
                    });
                    return users;
                }`
            },
        },

        interactionRules: {
            maxLikesPerSession: 10,
            maxFollowBacksPerSession: 5,
            engageWithMentions: true,
            engageWithLikes: true,
        }
    },

    // ==================== TIKTOK ====================
    tiktok: {
        platform: "tiktok",
        homeUrl: "https://www.tiktok.com/foryou",
        notificationsUrl: "https://www.tiktok.com/notifications",

        selectors: {
            notificationsNav: "a[data-e2e='nav-notifications']",
            notificationItem: "div[data-e2e='notification-item']",
            likeButton: "button[data-testid='like-button']",
            followBackButton: "button:has-text('Follow back')",
            userAvatar: "img[data-e2e='user-avatar']",
        },

        timing: {
            minDelayBetweenActions: 1500,
            maxDelayBetweenActions: 3500,
            notificationLoadDelay: 2000,
            navigationTimeout: 12000,
        },

        workflows: {
            readNotifications: {
                name: "Read TikTok notifications",
                steps: [
                    { action: "navigate", url: "${notificationsUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "notificationFeed" },
                ],
                extract: "notifications"
            },

            followBack: {
                name: "Follow back users on TikTok",
                steps: [
                    { action: "navigate", url: "${notificationsUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2500 },
                    { action: "click", selector: "${selectors.followBackButton}" },
                    { action: "pause", duration: 1000 },
                ],
            },
        },

        extractors: {
            notifications: {
                selector: "div[data-e2e='notification-item']",
                parseFunction: `(items) => {
                    const notifs = [];
                    items.forEach(item => {
                        try {
                            const textEl = item.querySelector('span');
                            notifs.push({ text: textEl?.textContent?.trim() || '' });
                        } catch(e) {}
                    });
                    return notifs;
                }`
            },
        },

        interactionRules: {
            maxFollowBacksPerSession: 5,
            maxLikesPerSession: 10,
        }
    },

    // ==================== FACEBOOK ====================
    facebook: {
        platform: "facebook",
        homeUrl: "https://www.facebook.com",
        notificationsUrl: "https://www.facebook.com/notifications",

        selectors: {
            notificationsNav: "a[aria-label*='Notifications']",
            notificationItem: "div[data-testid='notification']",
            likeButton: "button[aria-label*='Like']",
            followBackButton: "button:has-text('Follow')",
            scrollContainer: "div[role='feed']",
        },

        timing: {
            minDelayBetweenActions: 3000,
            maxDelayBetweenActions: 5000,
            notificationLoadDelay: 3000,
            navigationTimeout: 20000,
        },

        workflows: {
            readNotifications: {
                name: "Read Facebook notifications",
                steps: [
                    { action: "navigate", url: "${notificationsUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "notificationFeed" },
                ],
                extract: "notifications"
            },
            followBack: {
                name: "Follow back users on Facebook",
                steps: [
                    { action: "navigate", url: "${notificationsUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "click", selector: "${selectors.followBackButton}" },
                    { action: "pause", duration: 1500 },
                ],
            },
        },

        extractors: {
            notifications: {
                selector: "div[data-testid='notification']",
                parseFunction: `(items) => {
                    const notifs = [];
                    items.forEach(item => {
                        try {
                            const textEl = item.querySelector('span');
                            notifs.push({ text: textEl?.textContent?.trim() || '' });
                        } catch(e) {}
                    });
                    return notifs;
                }`
            },
        },

        interactionRules: {
            maxFollowBacksPerSession: 5,
            maxLikesPerSession: 10,
        }
    },

    // ==================== INSTAGRAM ====================
    instagram: {
        platform: "instagram",
        homeUrl: "https://www.instagram.com",
        notificationsUrl: "https://www.instagram.com/accounts/activity",

        selectors: {
            notificationsNav: "a[href*='activity']",
            notificationItem: "div[role='button']",
            likeButton: "button[aria-label*='Like']",
            followBackButton: "button:has-text('Follow')",
            scrollContainer: "div[class*='activity']",
        },

        timing: {
            minDelayBetweenActions: 2500,
            maxDelayBetweenActions: 5000,
            notificationLoadDelay: 3000,
            navigationTimeout: 20000,
        },

        workflows: {
            readNotifications: {
                name: "Read Instagram activity",
                steps: [
                    { action: "navigate", url: "${notificationsUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "notificationFeed" },
                ],
                extract: "notifications"
            },
            followBack: {
                name: "Follow back on Instagram",
                steps: [
                    { action: "navigate", url: "${notificationsUrl}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2500 },
                    { action: "click", selector: "${selectors.followBackButton}" },
                    { action: "pause", duration: 1500 },
                ],
            },
        },

        extractors: {
            notifications: {
                selector: "div[role='button']",
                parseFunction: `(items) => {
                    const notifs = [];
                    items.forEach(item => {
                        try {
                            const textEl = item.querySelector('span');
                            notifs.push({ text: textEl?.textContent?.trim() || '' });
                        } catch(e) {}
                    });
                    return notifs;
                }`
            },
        },

        interactionRules: {
            maxFollowBacksPerSession: 5,
            maxLikesPerSession: 10,
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
