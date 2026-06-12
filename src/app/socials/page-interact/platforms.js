import logger from "../../../../utils/logger.js";
import MultiProviderAI from "../../../../utils/multiProviderAI.js";

const ai = new MultiProviderAI();

export const platformConfigs = {
    // ==================== TWITTER / X ====================
    twitter: {
        platform: "twitter",
        homeUrl: "https://x.com/home",
        searchUrl: "https://x.com/search",
        profileUrl: "https://x.com",

        selectors: {
            profileNav: "a[aria-label='Profile']",
            followersCount: "a[href*='/followers'] span",
            followingCount: "a[href*='/following'] span",
            postsCount: "a[href*='/tweets'] span",
            followButton: "button[aria-label*='Follow']",
            unfollowButton: "button[aria-label*='Unfollow']",
            postItem: "article[role='presentation']",
            likeButton: "button[aria-label*='like']",
            followerModal: "div[role='dialog']",
            followerItem: "div[data-testid='UserCell']",
            scrollContainer: "main [role='region']",
        },

        timing: {
            minDelayBetweenActions: 2000,
            maxDelayBetweenActions: 5000,
            followDelay: 1500,
            scrollDelay: 2000,
            navigationTimeout: 15000,
        },

        workflows: {
            scrapeProfile: {
                name: "Scrape profile statistics",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "capturePageContent", captureName: "profilePage" },
                    { action: "pause", duration: 1000 },
                ],
                extract: "profileStats"
            },

            followUser: {
                name: "Follow a user from their profile",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.followButton}" },
                    { action: "pause", duration: 1500 },
                    { action: "capturePageContent", captureName: "followResult" },
                ],
                extract: "followResult"
            },

            unfollowUser: {
                name: "Unfollow a user",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.unfollowButton}" },
                    { action: "pause", duration: 1500 },
                ],
            },

            followFromFollowers: {
                name: "Follow users from target's followers list",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.followersCount}" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "followersList" },
                    { action: "scroll", distance: 600 },
                    { action: "pause", duration: 1500 },
                ],
                extract: "followerItems"
            },

            interactWithProfile: {
                name: "Like recent posts on a profile",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "scroll", distance: 400 },
                    { action: "pause", duration: 1500 },
                    { action: "likeRandomPosts", maxCount: 3 },
                ],
            },
        },

        aiPrompts: {
            analyzeProfile: "Analyze this profile. What is their main focus/niche? What kind of content do they post?",
            shouldFollowBack: "Based on this profile description, should we follow them back? Respond with ONLY: yes or no",
        },

        extractors: {
            profileStats: {
                selector: "main [role='region']",
                parseFunction: `(container) => {
                    const stats = {};
                    try {
                        const spans = container[0].querySelectorAll('a span');
                        spans.forEach(s => {
                            const text = s.textContent.trim();
                            if (text.match(/\\d+[KMB]?/)) stats.count = text;
                        });
                    } catch(e) {}
                    return [stats];
                }`
            },
            followResult: {
                selector: "button[aria-label*='Follow']",
                parseFunction: `(buttons) => {
                    return [{ followed: buttons.length === 0 }];
                }`
            },
            followerItems: {
                selector: "div[data-testid='UserCell']",
                parseFunction: `(cells) => {
                    const users = [];
                    cells.forEach(cell => {
                        try {
                            const nameEl = cell.querySelector('a[role=link]');
                            const followBtn = cell.querySelector('button[aria-label*=\\'Follow\\']');
                            if (nameEl) users.push({ username: nameEl.textContent.trim() });
                        } catch(e) {}
                    });
                    return users;
                }`
            },
        },

        interactionRules: {
            maxFollowsPerProfile: 5,
            maxUnfollowsPerProfile: 5,
            likeRecentPosts: true,
            maxLikesPerProfile: 3,
        }
    },

    // ==================== TIKTOK ====================
    tiktok: {
        platform: "tiktok",
        homeUrl: "https://www.tiktok.com/foryou",
        searchUrl: "https://www.tiktok.com/search",
        profileUrl: "https://www.tiktok.com",

        selectors: {
            profileNav: "a[data-e2e='nav-profile']",
            followersCount: "div[data-e2e='followers-count'] strong",
            followingCount: "div[data-e2e='following-count'] strong",
            likesCount: "div[data-e2e='likes-count'] strong",
            followButton: "button[data-e2e='follow-button']",
            followingButton: "button[data-e2e='following-button']",
            videoItem: "div[data-testid='video-item']",
            likeButton: "button[data-testid='like-button']",
            followerModal: "div[role='dialog']",
            followerSuggestion: ".suggested-tab-selector",
            userToFollow: ".user-to-follow",
        },

        timing: {
            minDelayBetweenActions: 1500,
            maxDelayBetweenActions: 4000,
            followDelay: 1000,
            scrollDelay: 1500,
            navigationTimeout: 12000,
        },

        workflows: {
            scrapeProfile: {
                name: "Scrape TikTok profile statistics",
                steps: [
                    { action: "navigate", url: "${profileUrl}/@${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "capturePageContent", captureName: "profilePage" },
                ],
                extract: "profileStats"
            },

            followUser: {
                name: "Follow a TikTok user",
                steps: [
                    { action: "navigate", url: "${profileUrl}/@${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.followButton}" },
                    { action: "pause", duration: 1500 },
                ],
            },

            followFromSuggested: {
                name: "Follow suggested users from followers list",
                steps: [
                    { action: "navigate", url: "${profileUrl}/@${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.followersCount}" },
                    { action: "pause", duration: 3000 },
                    { action: "click", selector: "${selectors.followerSuggestion}" },
                    { action: "pause", duration: 2000 },
                ],
                extract: "followerItems"
            },

            interactWithProfile: {
                name: "Like recent videos on a TikTok profile",
                steps: [
                    { action: "navigate", url: "${profileUrl}/@${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2000 },
                    { action: "clickVideo", videoIndex: 0 },
                    { action: "pause", duration: 2000 },
                    { action: "click", selector: "${selectors.likeButton}" },
                    { action: "pause", duration: 1000 },
                ],
            },
        },

        aiPrompts: {
            analyzeProfile: "Analyze this TikTok profile. What type of content creator are they? What is their niche/audience?",
            shouldFollowBack: "Based on this profile, should we follow them? Respond with ONLY: yes or no",
        },

        extractors: {
            profileStats: {
                selector: "div[data-e2e='followers-count']",
                parseFunction: `(elements) => {
                    return [{ followers: elements[0]?.textContent?.trim() || 'unknown' }];
                }`
            },
            followerItems: {
                selector: "div[data-e2e='user-item']",
                parseFunction: `(items) => {
                    const users = [];
                    items.forEach(item => {
                        try {
                            const nameEl = item.querySelector('span');
                            if (nameEl) users.push({ username: nameEl.textContent.trim() });
                        } catch(e) {}
                    });
                    return users;
                }`
            },
        },

        interactionRules: {
            maxFollowsPerProfile: 5,
            maxUnfollowsPerProfile: 5,
            likeRecentVideos: true,
            maxLikesPerProfile: 3,
        }
    },

    // ==================== FACEBOOK ====================
    facebook: {
        platform: "facebook",
        profileUrl: "https://www.facebook.com",

        selectors: {
            profileNav: "a[aria-label*='Profile']",
            followersCount: "a[href*='followers'] span",
            followingCount: "a[href*='following'] span",
            followButton: "button:has-text('Follow')",
            friendButton: "button:has-text('Friend')",
            postItem: "div[data-testid='post']",
            likeButton: "button[aria-label*='Like']",
            scrollContainer: "div[role='feed']",
        },

        timing: {
            minDelayBetweenActions: 3000,
            maxDelayBetweenActions: 6000,
            navigationTimeout: 20000,
        },

        workflows: {
            scrapeProfile: {
                name: "Scrape Facebook profile",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "profilePage" },
                ],
            },
            followUser: {
                name: "Follow a Facebook profile",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "click", selector: "${selectors.followButton}" },
                    { action: "pause", duration: 2000 },
                ],
            },
            interactWithProfile: {
                name: "Like recent posts on Facebook profile",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "scroll", distance: 500 },
                    { action: "pause", duration: 2000 },
                ],
            },
        },

        interactionRules: {
            maxFollowsPerProfile: 5,
            likeRecentPosts: true,
            maxLikesPerProfile: 3,
        }
    },

    // ==================== INSTAGRAM ====================
    instagram: {
        platform: "instagram",
        profileUrl: "https://www.instagram.com",

        selectors: {
            profileNav: "a[href*='instagram']",
            followersCount: "a[href*='followers'] span",
            followingCount: "a[href*='following'] span",
            followButton: "button:has-text('Follow')",
            followingButton: "button:has-text('Following')",
            postItem: "article[role='presentation']",
            likeButton: "button[aria-label*='Like']",
        },

        timing: {
            minDelayBetweenActions: 3000,
            maxDelayBetweenActions: 6000,
            navigationTimeout: 20000,
        },

        workflows: {
            scrapeProfile: {
                name: "Scrape Instagram profile",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "profilePage" },
                ],
            },
            followUser: {
                name: "Follow Instagram user",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2500 },
                    { action: "click", selector: "${selectors.followButton}" },
                    { action: "pause", duration: 2000 },
                ],
            },
            interactWithProfile: {
                name: "Like recent Instagram posts",
                steps: [
                    { action: "navigate", url: "${profileUrl}/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2500 },
                    { action: "scroll", distance: 400 },
                    { action: "pause", duration: 1500 },
                ],
            },
        },

        interactionRules: {
            maxFollowsPerProfile: 5,
            likeRecentPosts: true,
            maxLikesPerProfile: 3,
        }
    },

    // ==================== QUORA ====================
    quora: {
        platform: "quora",
        profileUrl: "https://www.quora.com",

        selectors: {
            followButton: "button:has-text('Follow')",
            followingButton: "button:has-text('Following')",
            upvoteButton: "button[aria-label*='Upvote']",
            profileName: "h1[class*='name']",
            profileBio: "div[class*='bio']",
        },

        timing: {
            minDelayBetweenActions: 2000,
            maxDelayBetweenActions: 5000,
            navigationTimeout: 15000,
        },

        workflows: {
            scrapeProfile: {
                name: "Scrape Quora profile",
                steps: [
                    { action: "navigate", url: "${profileUrl}/profile/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 3000 },
                    { action: "capturePageContent", captureName: "profilePage" },
                ],
            },
            followUser: {
                name: "Follow a Quora user",
                steps: [
                    { action: "navigate", url: "${profileUrl}/profile/${keyword}", waitUntil: "networkidle0" },
                    { action: "pause", duration: 2500 },
                    { action: "click", selector: "${selectors.followButton}" },
                    { action: "pause", duration: 1500 },
                ],
            },
        },

        interactionRules: {
            maxFollowsPerProfile: 5,
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

export function getInteractionRules(platform) {
    const config = getPlatformConfig(platform);
    return config.interactionRules || {};
}

export { ai as MultiProviderAI };
