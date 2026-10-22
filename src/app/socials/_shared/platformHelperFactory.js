import logger from "../../../utils/logger.js";
import {
    asSelectorList,
    clickByText,
    clickSelector,
    collectLinks,
    collectList,
    dismissPopups,
    exists,
    fillEditable,
    firstSelector,
    isLoggedOut,
    pause,
    pressEnter,
    probeSelectors,
    readNode,
    safeGoto,
    scrollBy,
    textPresent,
    toastMatches,
    verifyComposerCleared,
    verifyLabel,
    verifyOutgoingMessage,
} from "./socialDom.js";

function matches(pattern, value) {
    if (!pattern) return false;
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    return re.test(String(value || ""));
}

function nodeHaystack(node) {
    if (!node || !node.found) return "";
    return `${node.text || ""} ${node.label || ""} ${node.title || ""} ${node.className || ""}`.trim();
}

async function clickNth(page, selector, index) {
    const sels = asSelectorList(selector);
    if (!sels.length) return false;
    try {
        return await page.evaluate(({ sels, index }) => {
            for (const sel of sels) {
                const nodes = Array.from(document.querySelectorAll(sel)).filter((el) => {
                    const r = el.getBoundingClientRect();
                    return r.width >= 1 && r.height >= 1;
                });
                const el = nodes[index];
                if (el) { el.click(); return true; }
            }
            return false;
        }, { sels, index });
    } catch (_) {
        return false;
    }
}

async function waitFor(fn, timeout = 5000, interval = 250) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, interval));
    }
    return false;
}

export function createPlatformHelper(rawConfig = {}) {
    const config = {
        platform: rawConfig.platform || "unknown",
        capabilities: {
            follow: true,
            unfollow: true,
            like: true,
            comment: true,
            notifications: true,
            inbox: true,
            newDm: true,
            ...(rawConfig.capabilities || {}),
        },
        urls: {
            profile: null,
            notifications: null,
            messages: null,
            ...(rawConfig.urls || {}),
        },
        selectors: {},
        labels: {},
        postLinkFilter: null,
        notificationTypes: {},
        ...rawConfig,
    };
    config.selectors = { ...(rawConfig.selectors || {}) };
    config.labels = { ...(rawConfig.labels || {}) };

    const helper = {
        platform: config.platform,
        capabilities: config.capabilities,
        config,

        async probe(page) {
            return probeSelectors(page, config.selectors);
        },

        async openProfile(page, handle) {
            const clean = String(handle || "").trim().replace(/^@+/, "");
            if (!clean || !config.urls.profile) return false;
            const target = typeof config.urls.profile === "function"
                ? config.urls.profile(clean)
                : String(config.urls.profile).replace("{handle}", clean).replace("{username}", clean);
            const ok = await safeGoto(page, target);
            await helper.dismiss(page);
            return ok;
        },

        async openNotifications(page) {
            if (!config.urls.notifications) return false;
            const ok = await safeGoto(page, config.urls.notifications);
            await helper.dismiss(page);
            return ok;
        },

        async openMessages(page) {
            if (!config.urls.messages) return false;
            const ok = await safeGoto(page, config.urls.messages);
            await helper.dismiss(page);
            return ok;
        },

        async dismiss(page) {
            await dismissPopups(page, config.selectors.cookieBanner);
        },

        async isLoggedOut(page) {
            return isLoggedOut(page, config.selectors.loggedOut);
        },

        async followState(page) {
            if (!config.capabilities.follow) return { state: "unsupported" };
            const following = await readNode(page, firstSelector(config.selectors, ["followingButton", "unfollowButton"]));
            if (following.found) return { state: "following", node: following };
            const follow = await readNode(page, config.selectors.followButton);
            if (follow.found && matches(config.labels.follow, nodeHaystack(follow))) {
                return { state: "not-following", node: follow };
            }
            if (follow.found && matches(config.labels.following, nodeHaystack(follow))) {
                return { state: "following", node: follow };
            }
            return { state: "unknown", node: follow };
        },

        async follow(page) {
            if (!config.capabilities.follow) return { verified: false, reason: "unsupported" };
            const before = await helper.followState(page);
            if (before.state === "following") return { verified: true, already: true };
            const clicked = await clickSelector(page, config.selectors.followButton);
            if (!clicked) return { verified: false, reason: "follow-button-missing" };
            await pause(page, 700, 1400);
            const ok = await waitFor(async () => {
                const state = await helper.followState(page);
                return state.state === "following";
            }, 4000, 300);
            if (ok) return { verified: true };
            const currentNode = await readNode(page, config.selectors.followButton);
            if (currentNode.found && matches(config.labels.follow, nodeHaystack(currentNode))) {
                return { verified: false, reason: "still-not-following" };
            }
            return { unverified: true };
        },

        async unfollow(page) {
            if (!config.capabilities.unfollow) return { verified: false, reason: "unsupported" };
            const before = await helper.followState(page);
            if (before.state === "not-following") return { verified: true, already: true };
            if (before.state === "unknown") return { verified: false, reason: "follow-state-unknown" };
            const target = firstSelector(config.selectors, ["followingButton", "unfollowButton"]) || config.selectors.followButton;
            const clicked = await clickSelector(page, target);
            if (!clicked) return { verified: false, reason: "unfollow-button-missing" };
            await pause(page, 500, 1000);
            if (config.selectors.unfollowMenuItem) {
                await clickByText(page, config.selectors.unfollowMenuItem, config.labels.unfollow || /unfollow/i);
                await pause(page, 600, 1200);
            }
            const ok = await waitFor(async () => {
                const state = await helper.followState(page);
                return state.state === "not-following";
            }, 4000, 300);
            return ok ? { verified: true } : { unverified: true };
        },

        async listPostLinks(page, limit = 20) {
            const links = await collectLinks(page, config.selectors.postLink, config.postLinkFilter);
            const clean = [];
            for (const href of links) {
                const abs = href.startsWith("http") ? href : `https://${config.platform === "twitter" ? "x.com" : "www." + config.platform + ".com"}${href.startsWith("/") ? "" : "/"}${href}`;
                if (!clean.includes(abs)) clean.push(abs);
                if (clean.length >= limit) break;
            }
            return clean;
        },

        async openPost(page, href) {
            const ok = await safeGoto(page, href);
            await helper.dismiss(page);
            return ok;
        },

        async isPostLiked(page) {
            const active = await readNode(page, config.selectors.likeActive);
            if (active.found) return true;
            const node = await readNode(page, config.selectors.likeButton);
            if (!node.found) return false;
            if (node.pressed === "true") return true;
            return matches(config.labels.liked, nodeHaystack(node));
        },

        async like(page) {
            if (!config.capabilities.like) return { verified: false, reason: "unsupported" };
            if (await helper.isPostLiked(page)) return { verified: true, already: true };
            const clicked = await clickSelector(page, config.selectors.likeButton);
            if (!clicked) return { verified: false, reason: "like-button-missing" };
            await pause(page, 500, 1000);
            const ok = await waitFor(() => helper.isPostLiked(page), 3500, 250);
            if (ok) return { verified: true };
            const node = await readNode(page, config.selectors.likeButton);
            if (node.found && node.pressed === "false") return { verified: false, reason: "aria-pressed-false" };
            return { unverified: true };
        },

        async openComments(page) {
            if (!config.capabilities.comment) return false;
            const composer = await exists(page, config.selectors.commentComposer);
            if (composer) return true;
            const clicked = await clickSelector(page, config.selectors.commentButton);
            if (!clicked) return false;
            await pause(page, 800, 1600);
            if (config.selectors.commentComposer) {
                return waitFor(() => exists(page, config.selectors.commentComposer), 5000, 300);
            }
            return true;
        },

        async comment(page, text) {
            if (!config.capabilities.comment) return { verified: false, reason: "unsupported" };
            const open = await helper.openComments(page);
            if (!open) return { verified: false, reason: "comments-unavailable" };
            const filled = await fillEditable(page, config.selectors.commentComposer, text);
            if (!filled) return { verified: false, reason: "composer-missing" };
            await pause(page, 350, 700);
            let submitted = false;
            if (config.selectors.commentSubmit) submitted = await clickSelector(page, config.selectors.commentSubmit);
            if (!submitted) await pressEnter(page);
            await pause(page, 1200, 2200);
            const cleared = await verifyComposerCleared(page, config.selectors.commentComposer);
            if (cleared.verified) return { verified: true };
            const visible = await textPresent(page, text, config.selectors.commentContainer);
            if (visible) return { verified: true };
            return cleared.unverified ? { unverified: true } : { verified: false, reason: cleared.reason || "comment-not-confirmed" };
        },

        async nextPost(page) {
            if (config.selectors.nextButton) {
                const clicked = await clickSelector(page, config.selectors.nextButton);
                if (clicked) { await pause(page, 800, 1500); return true; }
            }
            try { await page.keyboard.press("ArrowDown"); await pause(page, 900, 1600); return true; } catch (_) { /* fall through */ }
            return scrollBy(page, 700);
        },

        async listNotifications(page, limit = 30) {
            if (!config.capabilities.notifications) return [];
            const rows = await collectList(page, config.selectors.notificationItem, {
                text: "",
                href: { attr: "href" },
            });
            return rows.slice(0, limit).map((row, index) => {
                const type = matches(config.notificationTypes.follow, row.text) ? "follow"
                    : matches(config.notificationTypes.comment, row.text) ? "comment"
                    : matches(config.notificationTypes.like, row.text) ? "like"
                    : "other";
                return { index, text: row.text, href: row.href || "", type };
            });
        },

        async followBack(page, index = 0) {
            if (!config.capabilities.follow) return { verified: false, reason: "unsupported" };
            const selector = config.selectors.notificationFollowBack || config.selectors.followButton;
            const clicked = await clickNth(page, selector, index);
            if (!clicked) return { verified: false, reason: "follow-back-button-missing" };
            await pause(page, 700, 1400);
            const node = await readNode(page, selector);
            if (!node.found) return { verified: true };
            if (matches(config.labels.following, nodeHaystack(node))) return { verified: true };
            if (matches(config.labels.follow, nodeHaystack(node))) return { verified: false, reason: "still-follow" };
            return { unverified: true };
        },

        async openNotificationTarget(page, index = 0) {
            if (config.selectors.notificationLink) {
                const clicked = await clickNth(page, config.selectors.notificationLink, index);
                if (clicked) { await pause(page, 1500, 2800); return true; }
            }
            const clicked = await clickNth(page, config.selectors.notificationItem, index);
            if (clicked) { await pause(page, 1500, 2800); return true; }
            return false;
        },

        async listConversations(page, limit = 25) {
            if (!config.capabilities.inbox) return [];
            const rows = await collectList(page, config.selectors.conversationItem, {
                text: "",
                name: config.selectors.conversationName || "",
                snippet: config.selectors.conversationSnippet || "",
                unread: config.selectors.conversationUnread || "",
            });
            return rows.slice(0, limit).map((row, index) => ({
                index,
                text: row.text,
                name: row.name || "",
                snippet: row.snippet || "",
                unread: !!row.unread,
            }));
        },

        async openConversation(page, index = 0) {
            const clicked = await clickNth(page, config.selectors.conversationItem, index);
            if (clicked) { await pause(page, 1200, 2400); return true; }
            return false;
        },

        async lastMessageText(page) {
            const incoming = await collectList(page, config.selectors.incomingMessage, { text: "" });
            if (incoming.length) return incoming[incoming.length - 1].text;
            const all = await collectList(page, config.selectors.messageBubble || config.selectors.outgoingMessage, { text: "" });
            return all.length ? all[all.length - 1].text : "";
        },

        async sendMessageText(page, text) {
            if (!config.capabilities.inbox) return { verified: false, reason: "unsupported" };
            const filled = await fillEditable(page, config.selectors.messageInput, text);
            if (!filled) return { verified: false, reason: "message-input-missing" };
            await pause(page, 300, 600);
            let sent = false;
            if (config.selectors.messageSend) sent = await clickSelector(page, config.selectors.messageSend);
            if (!sent) await pressEnter(page);
            await pause(page, 1200, 2200);
            const cleared = await verifyComposerCleared(page, config.selectors.messageInput);
            const bubble = config.selectors.outgoingMessage
                ? await verifyOutgoingMessage(page, text, config.selectors.outgoingMessage)
                : { verified: false };
            if (bubble.verified) return { verified: true };
            if (cleared.verified) return { verified: true, composerClearedOnly: true };
            if (config.selectors.outgoingMessage) {
                const toast = await toastMatches(page, /sent|delivered/i);
                if (toast) return { verified: true, toast: true };
            }
            return cleared.unverified ? { unverified: true } : { verified: false, reason: cleared.reason || "send-not-confirmed" };
        },

        async sendNewMessage(page, recipient, text) {
            if (!config.capabilities.newDm) return { verified: false, reason: "unsupported" };
            if (config.selectors.newMessageButton) {
                const opened = await clickSelector(page, config.selectors.newMessageButton);
                if (!opened) return { verified: false, reason: "new-message-button-missing" };
                await pause(page, 900, 1600);
            }
            const filled = await fillEditable(page, config.selectors.recipientInput, recipient);
            if (!filled) return { verified: false, reason: "recipient-input-missing" };
            await pause(page, 900, 1600);
            let picked = false;
            if (config.selectors.recipientResult) {
                picked = await clickByText(page, config.selectors.recipientResult, recipient);
            }
            if (!picked) await pressEnter(page);
            await pause(page, 1000, 1800);
            return helper.sendMessageText(page, text);
        },
    };

    return helper;
}
