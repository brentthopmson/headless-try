import logger from "../../../utils/logger.js";
import {
    isTikTokCaptchaVisible,
    solveTikTokAudioCaptcha,
    isTikTokLoggedOut,
    navigateAndWait,
    dismissCookieBanner,
    readCommentsPanelCount,
    ensureCommentsVisible,
    isPostLiked,
    isConfidentlyUnliked,
} from "../search-interact/platformHelper/TikTokHelpers.js";
import { updateAccountStatus } from "./hubUpdater.js";

export {
    isTikTokCaptchaVisible,
    solveTikTokAudioCaptcha,
    isTikTokLoggedOut,
    navigateAndWait,
    dismissCookieBanner,
    readCommentsPanelCount,
    ensureCommentsVisible,
    isPostLiked,
    isConfidentlyUnliked,
};

export async function enforceSingleTab(page, logPrefix = "") {
    try {
        const browser = page.browser();
        if (!browser) return;
        const pages = await browser.pages().catch(() => []);
        let closed = 0;
        for (const other of pages) {
            if (other === page) continue;
            try {
                if (other.target && page.target && other.target() === page.target()) continue;
            } catch (_) { /* compare failed */ }
            try { await other.close(); closed += 1; } catch (_) { /* already gone */ }
        }
        try { await page.bringToFront(); } catch (_) { /* best effort */ }
        if (closed) logger.info(`${logPrefix} closed ${closed} extra tab(s)`);
    } catch (e) {
        logger.debug(`[enforceSingleTab] ${e.message}`);
    }
}

export function attachSingleTabGuard(page, logPrefix = "") {
    try {
        const browser = page.browser();
        if (!browser) return () => {};
        const onNewTarget = async (target) => {
            try {
                if (!target || target.type() !== "page") return;
                const other = await target.page();
                if (!other || other === page) return;
                await new Promise((r) => setTimeout(r, 350));
                try { await other.close(); } catch (_) { /* gone */ }
                try { await page.bringToFront(); } catch (_) { /* best effort */ }
            } catch (_) { /* ignore */ }
        };
        browser.on("targetcreated", onNewTarget);
        return () => {
            try { browser.off("targetcreated", onNewTarget); } catch (_) { /* ignore */ }
        };
    } catch (_) {
        return () => {};
    }
}

export async function handleTikTokGuards(page, options = {}) {
    const profileId = options.profileId || null;
    const logPrefix = options.logPrefix || "[tiktok]";
    const visible = await isTikTokCaptchaVisible(page);
    if (visible) {
        const solved = await solveTikTokAudioCaptcha(page, logPrefix);
        if (!solved) {
            if (profileId) await updateAccountStatus(profileId, "WAITING").catch(() => {});
            return { ok: false, stopType: "captcha", reason: "captcha_unsolved" };
        }
    }
    if (await isTikTokLoggedOut(page)) {
        if (profileId) await updateAccountStatus(profileId, "LOGGED_OUT").catch(() => {});
        return { ok: false, stopType: "logged_out", reason: "logged_out" };
    }
    return { ok: true };
}
