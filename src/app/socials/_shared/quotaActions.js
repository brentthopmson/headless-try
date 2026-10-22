import logger from "../../../utils/logger.js";
import limitsCore from "./limitsCore.js";

const { canonicalAction } = limitsCore;

// Unambiguous selector-key → base action. Workflow steps may override with an
// explicit `quotaAction` (and `quotaSelector`) when the name is not enough.
const SELECTOR_ACTION = {
    likeButton: "like",
    likeIcon: "like",
    upvoteButton: "upvote",
    commentLikeButton: "likeComment",
    followButton: "follow",
    followBackButton: "follow",
    unfollowButton: "unfollow",
    followingButton: "unfollow",
    commentSubmit: "comment",
    commentPost: "comment",
    replySubmit: "commentComment",
    commentReplySubmit: "commentComment",
    sendButton: "coldMessage",
    sendMessageButton: "coldMessage",
    messageSendButton: "coldMessage",
    dmSendButton: "coldMessage",
    inboxReplyButton: "inboxReply",
    sendReplyButton: "inboxReply",
    replySendButton: "inboxReply",
    dmReplySendButton: "inboxReply",
    // Reposts (reserved for future workers — same inference/verification path).
    repostButton: "repost",
    repostIcon: "repost",
    repostSubmit: "repost",
    repostConfirm: "repost",
    repostConfirmButton: "repost",
    repostMenuItem: "repost",
    repostCommentButton: "repostComment",
    repostCommentSubmit: "repostComment",
    repostStoryButton: "repostStory",
    repostStorySubmit: "repostStory",
};

// Composer selector keys per action (used to verify the text was submitted).
const COMPOSER_KEYS = {
    comment: ["commentBox", "commentInput", "commentInputContainer"],
    commentComment: ["commentReplyInput", "replyTextBox", "commentReplyInputContainer"],
    coldMessage: ["messageInput", "messageBox", "dmInput", "chatInput"],
    inboxReply: ["messageInput", "messageBox", "dmInput", "chatInput", "replyInput", "inboxReplyInput"],
};

const PLACEHOLDER_RE = /\$\{selectors\.([a-zA-Z0-9_]+)\}/;

// Resolve the base quota action for a workflow step, or null when the step is
// not an accounted action.
export function stepQuotaAction(step) {
    if (!step) return null;
    if (step.quotaAction) return canonicalAction(step.quotaAction);
    const raw = step.selector || step.quotaSelector || "";
    const m = String(raw).match(PLACEHOLDER_RE);
    if (m && SELECTOR_ACTION[m[1]]) return canonicalAction(SELECTOR_ACTION[m[1]]);
    if (SELECTOR_ACTION[step.selector]) return canonicalAction(SELECTOR_ACTION[step.selector]);
    return null;
}

export function createTally() {
    const tally = {};
    const add = (baseAction, count = 1) => {
        const n = Number(count) || 0;
        if (n <= 0) return tally;
        const key = canonicalAction(baseAction);
        tally[key] = (tally[key] || 0) + n;
        return tally;
    };
    const total = () => Object.values(tally).reduce((a, b) => a + b, 0);
    return { tally, add, total };
}

function firstSelector(selectors, keys) {
    for (const k of keys) {
        if (selectors && selectors[k]) return selectors[k];
    }
    return null;
}

// Verify that an accounted action really happened after its step ran.
// Returns { verified, unverified }:
//   verified  — platform state confirms the action (count it)
//   unverified — no reliable signal on this platform (count it, warn)
async function verifyLike(page, selector) {
    if (!selector) return { unverified: true };
    return page.evaluate((sel) => {
        const els = Array.from(document.querySelectorAll(sel));
        if (!els.length) return { verified: false, reason: "element-missing" };
        for (const el of els) {
            const pressed = el.getAttribute("aria-pressed");
            if (pressed === "true") return { verified: true };
            const cls = String(el.className || "");
            if (/\b(active|liked|selected)\b/i.test(cls)) return { verified: true };
            if (pressed === "false") return { verified: false, reason: "aria-pressed-false" };
        }
        return { unverified: true };
    }, selector).catch(() => ({ unverified: true }));
}

async function verifyFollow(page, selector, wantFollowed) {
    if (!selector) return { unverified: true };
    return page.evaluate(({ sel, wantFollowed }) => {
        const els = Array.from(document.querySelectorAll(sel));
        if (!els.length) return { verified: false, reason: "element-missing" };
        const label = els.map(el => `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`).join(" ").toLowerCase();
        const followed = /following|unfollow/.test(label) && !/^follow\b/.test(label.trim());
        if (wantFollowed && followed) return { verified: true };
        if (!wantFollowed && !followed && /follow/.test(label)) return { verified: true };
        return { verified: false, reason: `state=${followed ? "following" : "not-following"}` };
    }, { sel: selector, wantFollowed }).catch(() => ({ unverified: true }));
}

// Repost confirmation is not consistently exposed: platforms use a pressed
// toggle, a menu item that disappears, or a toast. Accept any positive signal;
// a present-but-unmarked button is treated as unverified (counted with a
// warning) so a future worker never silently under-counts.
async function verifyRepost(page, selector) {
    if (!selector) return { unverified: true };
    return page.evaluate((sel) => {
        const toast = Array.from(document.querySelectorAll("[role='alert'], [class*='Toast'], [class*='toast']"))
            .map(el => (el.textContent || "").trim().toLowerCase())
            .some(t => /repost/.test(t));
        if (toast) return { verified: true };
        const els = Array.from(document.querySelectorAll(sel));
        if (!els.length) return { unverified: true };
        for (const el of els) {
            const pressed = el.getAttribute("aria-pressed");
            if (pressed === "true") return { verified: true };
            const label = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.className || ""}`.toLowerCase();
            if (/reposted|unrepost/.test(label)) return { verified: true };
            if (pressed === "false") return { verified: false, reason: "aria-pressed-false" };
        }
        return { unverified: true };
    }, selector).catch(() => ({ unverified: true }));
}

async function verifyComposerCleared(page, selector) {
    if (!selector) return { unverified: true };
    return page.evaluate((sel) => {
        const els = Array.from(document.querySelectorAll(sel));
        if (!els.length) return { unverified: true };
        const ed = els.find(el => el.isContentEditable) || els[0];
        const text = (ed.textContent || ed.value || "").trim();
        return text ? { verified: false, reason: "composer-not-cleared" } : { verified: true };
    }, selector).catch(() => ({ unverified: true }));
}

export async function verifyQuotaAction(page, baseAction, selectors = {}) {
    const action = canonicalAction(baseAction);
    switch (action) {
        case "likeOnPost":
            return verifyLike(page, firstSelector(selectors, ["likeButton", "likeIcon"]));
        case "upvote":
            return verifyLike(page, firstSelector(selectors, ["upvoteButton"]));
        case "likesOnComment":
            return verifyLike(page, firstSelector(selectors, ["commentLikeButton"]));
        case "follow":
            return verifyFollow(page, firstSelector(selectors, ["followButton", "followBackButton"]), true);
        case "unfollow":
            return verifyFollow(page, firstSelector(selectors, ["unfollowButton", "followingButton", "followButton"]), false);
        case "commentOnPost":
            return verifyComposerCleared(page, firstSelector(selectors, COMPOSER_KEYS.comment));
        case "commentOnComment":
            return verifyComposerCleared(page, firstSelector(selectors, COMPOSER_KEYS.commentComment));
        case "coldMessage":
            return verifyComposerCleared(page, firstSelector(selectors, COMPOSER_KEYS.coldMessage));
        case "inboxReply":
            return verifyComposerCleared(page, firstSelector(selectors, COMPOSER_KEYS.inboxReply));
        case "repostOnPost":
            return verifyRepost(page, firstSelector(selectors, ["repostButton", "repostIcon", "repostConfirmButton"]));
        case "repostOnComment":
            return verifyRepost(page, firstSelector(selectors, ["repostCommentButton", "repostCommentSubmit", "repostButton"]));
        case "repostOnStory":
            return verifyRepost(page, firstSelector(selectors, ["repostStoryButton", "repostStorySubmit", "repostButton"]));
        default:
            return { unverified: true };
    }
}

// Verify + account a single step. Returns true when it was counted.
export async function accountStep(page, baseAction, selectors, tally, logPrefix = "") {
    const res = await verifyQuotaAction(page, baseAction, selectors);
    if (res.verified) {
        tally.add(baseAction);
        return true;
    }
    if (res.unverified) {
        logger.warn(`${logPrefix} [quota] ${canonicalAction(baseAction)} counted as unverified (no platform state signal)`);
        tally.add(baseAction);
        return true;
    }
    logger.info(`${logPrefix} [quota] ${canonicalAction(baseAction)} NOT counted (${res.reason || "unverified"})`);
    return false;
}
