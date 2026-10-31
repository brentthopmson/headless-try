import logger from '../../../utils/logger.js';
import { launchBrowserWithSession, downloadAndExtractProfile } from '../../socials/_shared/routeHelper.js';
import { getPlatformConfig, getExtractor } from './platforms.js';
import { createTab, gotoRobust, sleep } from '../shared/browser.js';

export async function extractSocial(session, username, explicitPlatform, browserId) {
    const cookieJSON = session.cookieJSON;
    // Resolution chain: explicit arg → stored socials[] hint → row platform
    // column → category. Each candidate must map to a known extractor config;
    // no hint at all → skip entirely (never guess and navigate the wrong site,
    // e.g. x.com for a TikTok row).
    const candidates = [
        [explicitPlatform, 'explicit'],
        [session.socialPlatform, 'socials'],
        [session.storedPlatform, 'row-platform'],
        [session.category, 'category'],
    ];
    let platformKey = '';
    let platformSource = '';
    for (const [raw, source] of candidates) {
        const key = String(raw || '').toLowerCase().trim();
        if (!key || key === 'auto' || key === 'unknown') continue;
        try {
            getPlatformConfig(key);
            platformKey = key;
            platformSource = source;
            break;
        } catch (e) { /* not a known social platform — try next hint */ }
    }
    if (!platformKey) {
        logger.info(`[smartExtract] No platform hint for ${browserId} (socials/platform/category empty or unknown) — skipping social auto-extract`);
        return [];
    }
    logger.info(`[smartExtract] platform=${platformKey} (source=${platformSource}) browserId=${browserId}`);
    const config = getPlatformConfig(platformKey);

    // Download profile from Drive if available
    let profileDir = null;
    if (session.driveUrl) {
        try {
            profileDir = await downloadAndExtractProfile(session.driveUrl, browserId);
        } catch (e) {
            logger.warn(`[smartExtract] social profile download failed: ${e.message}`);
        }
    }

    const { browser, page } = await launchBrowserWithSession(cookieJSON, undefined, {
        userDataDir: profileDir,
        identity: session.browserIdentity,
        platform: platformKey,
        driveCookieJSON: session.driveCookieJSON,
        accountCookieJSON: session.accountCookieJSON,
        cookieJSON: session.cookieJSON,
    });
    let tab1;
    // Set true only on the final successful return — drives the profile refresh in finally.
    let extractionSucceeded = false;
    try {
        tab1 = await createTab(browser, cookieJSON);

        const profile = { followersCount: 0, followingCount: 0, lastPostDate: '', recentActivity: [], followers: [] };
        const account = {
            accountId: session.browserId,
            platform: platformKey,
            username: username || session.email,
            lastUsed: '',
            active: true,
            ipAddress: '',
            device: { userAgent: '', browser: '', os: '' },
            extractedDetails: profile,
            detailsExtractedFrom: '',
        };

        const usernameClean = String(username || '').replace('@', '');

        const [profileResult, followersResult] = await Promise.all([
            (async () => {
                try {
                    const profileUrl = config.profileUrl.replace('{username}', usernameClean);
                    await gotoRobust(page, profileUrl);
                    const extractor = getExtractor(platformKey, 'profile');
                    if (extractor?.parseFunction) {
                        const parseFunc = new Function('items', extractor.parseFunction);
                        const elements = await page.$$(extractor.selector);
                        const data = parseFunc(elements);
                        profile.followersCount = parseCount(data?.stats?.followers);
                        profile.followingCount = parseCount(data?.stats?.following);
                        profile.lastPostDate = data?.recentTweets?.[0]?.url ? new Date().toISOString() : '';
                        profile.recentActivity = (data?.recentTweets || []).slice(0, 5).map(t => ({
                            type: 'POST', on: '', text: t.text || '',
                        }));
                    }
                    logger.info(`[smartExtract] tab DONE social-profile`);
                } catch (e) {
                    logger.warn(`[smartExtract] tab FAIL social-profile: ${e.message}`);
                }
            })(),
            (async () => {
                try {
                    if (config.followersUrl) {
                        const followersUrl = config.followersUrl.replace('{username}', usernameClean);
                        await gotoRobust(tab1, followersUrl);
                        const extractor = getExtractor(platformKey, 'followers');
                        if (extractor?.parseFunction) {
                            const seen = new Set();
                            for (let i = 0; i < 5; i++) {
                                const parseFunc = new Function('items', extractor.parseFunction);
                                const elements = await tab1.$$(extractor.selector);
                                const batch = parseFunc(elements);
                                if (!Array.isArray(batch)) break;
                                for (const f of batch) {
                                    const key = f.username || f.name || f.email || '';
                                    if (!key || seen.has(key)) continue;
                                    seen.add(key);
                                    profile.followers.push({
                                        username: f.username || f.name || '',
                                        fullName: f.fullName || f.name || '',
                                        profileUrl: f.profileUrl || '',
                                        isFollowingYou: false,
                                        email: f.email || '',
                                        phone: f.phone || 0,
                                        relationshipSummary: f.bio || '',
                                    });
                                }
                                if (profile.followers.length >= 100 || profile.followers.length === 0) break;
                                await tab1.evaluate(() => window.scrollBy(0, 900));
                                await sleep(1800);
                            }
                            profile.followers = profile.followers.slice(0, 100);
                        }
                    }
                    logger.info(`[smartExtract] tab DONE social-followers`);
                } catch (e) {
                    logger.warn(`[smartExtract] tab FAIL social-followers: ${e.message}`);
                }
            })(),
        ]);

        account.extractedDetails = profile;
        account.detailsExtractedFrom = config.profileUrl || '';
        extractionSucceeded = true;
        return [account];
    } finally {
        // --- Post-extraction refresh: DISABLED (NO-TAMPER 2026-10-13) ---
        // Never write cookie/browser data back after extraction — use the
        // stored login-time session as-is (launcher principle). See wire
        // extractor finally block for the A/B evidence.
        logger.warn(`[smartExtract] Post-extraction refresh disabled (NO-TAMPER, social) — keeping login-time cookieJSON/driveUrl/browserIdentity for ${browserId || 'unknown'}`);
        // let freshCookies = [];
        // if (extractionSucceeded && page && !page.isClosed()) {
        //     try {
        //         const jars = [];
        //         try { jars.push(...await page.cookies()); } catch (_) {}
        //         if (tab1 && !tab1.isClosed()) { try { jars.push(...await tab1.cookies()); } catch (_) {} }
        //         const seen = new Set();
        //         freshCookies = jars.filter(c => {
        //             const k = `${c.name}|${c.domain}`;
        //             if (seen.has(k)) return false;
        //             seen.add(k);
        //             return true;
        //         });
        //         logger.info(`[smartExtract] Captured ${freshCookies.length} fresh cookies for social profile refresh`);
        //     } catch (e) {
        //         logger.warn(`[smartExtract] Fresh cookie capture failed: ${e.message}`);
        //     }
        // }
        await Promise.all([
            page.close().catch(() => {}),
            tab1?.close().catch(() => {}),
        ]);
        await browser.close().catch(() => {});
        if (profileDir) {
            // if (extractionSucceeded && browserId && freshCookies.length > 0) {
            //     try {
            //         const updateData = {
            //             cookieJSON: JSON.stringify(freshCookies),
            //             formattedCookie: JSON.stringify(freshCookies, null, 2),
            //             lastUserActivity: new Date().toISOString(),
            //         };
            //         if (browser && browser.identity) {
            //             try { updateData.browserIdentity = JSON.stringify(browser.identity); } catch (_) {}
            //         }
            //         const uploadResult = await uploadBrowserDataRaw(browserId, updateData, profileDir, { force: true });
            //         if (uploadResult && uploadResult.ok && uploadResult.url) {
            //             updateData.driveUrl = uploadResult.url;
            //             logger.info(`[smartExtract] Refreshed social profile uploaded for ${browserId}: ${uploadResult.url}`);
            //         } else {
            //             logger.warn(`[smartExtract] Social profile refresh upload failed for ${browserId}: ${uploadResult?.reason || 'unknown'}`);
            //         }
            //         await setCachedRow(browserId, updateData);
            //         await immediateFlush(browserId);
            //     } catch (e) {
            //         logger.warn(`[smartExtract] Social profile refresh failed (non-fatal): ${e.message}`);
            //     }
            // }
            const fs = await import('fs-extra');
            await fs.remove(profileDir).catch(() => {});
        }
    }
}

export function parseCount(val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const s = String(val).toLowerCase();
    const m = s.match(/([\d.]+)\s*([kmb]?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (m[2] === 'k') return Math.round(n * 1000);
    if (m[2] === 'm') return Math.round(n * 1000000);
    if (m[2] === 'b') return Math.round(n * 1000000000);
    return Math.round(n);
}
