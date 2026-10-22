import logger from "../../../utils/logger.js";
import { resolveSocialSession } from "./routeHelper.js";

// Live selector probe: opens the relevant surface once and reports which
// configured selectors resolve, so a human can confirm/correct the mapping
// before running real engagements.
export async function probeSocialPlatform(options = {}) {
    const helper = options.helper;
    const taskPayload = options.taskPayload || {};
    const platform = String(taskPayload.platform || helper?.platform || "").toLowerCase();
    const mode = String(options.mode || taskPayload.probeMode || "profile").toLowerCase();
    const cookieJSON = taskPayload.cookieJSON;

    if (!helper) throw new Error(`No platform helper for ${platform}`);
    if (!platform) throw new Error("Platform not specified");
    if (!cookieJSON) throw new Error("No cookies provided");

    let browser = null;
    let page = null;
    const { browser: b, page: p } = await resolveSocialSession({
        cookies: cookieJSON,
        browserIdentity: taskPayload.browserIdentity || null,
        driveUrl: taskPayload.driveUrl || "",
        profileId: taskPayload.profileId || taskPayload.accountId || null,
        platform,
    });
    browser = b;
    page = p;

    try {
        const target = String(taskPayload.targetUsername || taskPayload.searchQuery || taskPayload.recipient || "").trim();
        let opened = false;
        if (mode === "notifications") opened = await helper.openNotifications(page);
        else if (mode === "messages" || mode === "inbox") opened = await helper.openMessages(page);
        else if (target) opened = await helper.openProfile(page, target);
        else if (helper.config?.urls?.messages) opened = await helper.openMessages(page);
        else if (helper.config?.urls?.notifications) opened = await helper.openNotifications(page);

        const selectors = await helper.probe(page);
        const resolved = Object.entries(selectors || {})
            .filter(([, info]) => info && info.found)
            .map(([key]) => key);

        return {
            platform,
            mode,
            opened,
            url: page.url(),
            loggedOut: await helper.isLoggedOut(page).catch(() => false),
            capabilities: helper.capabilities,
            selectorCount: Object.keys(selectors || {}).length,
            resolved,
            selectors,
        };
    } finally {
        try { if (page) await page.close(); } catch (_) { /* ignore */ }
        try { if (browser) await browser.close(); } catch (_) { /* ignore */ }
        logger.info(`[probe] ${platform} ${mode} done`);
    }
}
