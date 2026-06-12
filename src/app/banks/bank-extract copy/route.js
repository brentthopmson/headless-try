import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { launchBrowserWithSession, DOMHelpers, setCorsHeaders } from '../../socials/_shared/routeHelper.js';

export const maxDuration = 120;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const BANK_SITES = {
    chase: {
        loginUrl: "https://chase.com",
        selectors: {
            usernameInput: "input[name='userId']",
            passwordInput: "input[name='password']",
            signInButton: "button[id='signin-button']",
            accountsOverview: "div[data-testid='account-card']",
            accountName: "h3[data-testid='account-name']",
            accountBalance: "span[data-testid='account-balance']",
            transactionsTable: "table[data-testid='transactions-table']",
            transactionRow: "tr[data-testid='transaction-row']",
            transactionDate: "td[data-testid='transaction-date']",
            transactionAmount: "td[data-testid='transaction-amount']",
            transactionDescription: "td[data-testid='transaction-description']",
        },
    },
    // Additional banks can be added here
};

async function extractAccounts(page) {
    return await page.evaluate(() => {
        const accounts = [];
        document.querySelectorAll("div[data-testid='account-card'], .account-card, [class*='account']").forEach(card => {
            const nameEl = card.querySelector("h3, .account-name, [class*='name']");
            const balanceEl = card.querySelector("span[data-testid='account-balance'], .balance, [class*='balance']");
            const numberEl = card.querySelector("[class*='account-number'], [class*='accountNumber']");

            if (nameEl) {
                accounts.push({
                    name: nameEl.textContent.trim(),
                    balance: balanceEl?.textContent?.trim() || "N/A",
                    number: numberEl?.textContent?.trim() || "N/A",
                    type: card.getAttribute("data-testid")?.includes("savings") ? "SAVINGS" : "CHECKING",
                });
            }
        });
        return accounts;
    });
}

async function extractTransactions(page) {
    return await page.evaluate(() => {
        const transactions = [];
        document.querySelectorAll("tr[data-testid='transaction-row'], .transaction-row, [class*='transaction']").forEach(row => {
            const dateEl = row.querySelector("td[data-testid='transaction-date'], .date, [class*='date']");
            const amountEl = row.querySelector("td[data-testid='transaction-amount'], .amount, [class*='amount']");
            const descEl = row.querySelector("td[data-testid='transaction-description'], .description, [class*='desc']");

            if (dateEl || amountEl) {
                transactions.push({
                    date: dateEl?.textContent?.trim() || "",
                    amount: amountEl?.textContent?.trim() || "",
                    description: descEl?.textContent?.trim() || "",
                });
            }
        });
        return transactions;
    });
}

async function extractProfile(page) {
    return await page.evaluate(() => {
        const getText = (selectors) => {
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) return el.textContent.trim();
            }
            return "";
        };

        return {
            name: getText(["[class*='profile-name']", "[class*='user-name']", "h1"]),
            email: getText(["[class*='email']", "[class*='profile-email']"]),
            phone: getText(["[class*='phone']", "[class*='profile-phone']"]),
            address: getText(["[class*='address']", "[class*='profile-address']"]),
        };
    });
}

async function extractBankData(platform, cookies) {
    const cookieJSON = typeof cookies === "string" ? cookies : JSON.stringify(cookies);
    const { browser, page } = await launchBrowserWithSession(cookieJSON);

    try {
        const bankConfig = BANK_SITES[platform];
        const baseUrl = bankConfig?.loginUrl || `https://${platform}.com`;

        // Navigate to bank homepage (should auto-redirect to dashboard if cookies valid)
        await page.goto(baseUrl, { waitUntil: "networkidle0", timeout: 30000 });
        await DOMHelpers.randomDelay(2000, 3000);

        // Try to find accounts overview
        const accounts = await extractAccounts(page);

        // Try to navigate to transactions
        let transactions = [];
        try {
            const txnLinks = await page.$$("a[href*='transaction'], a[href*='activity'], a:has-text('Transactions')");
            if (txnLinks.length > 0) {
                await txnLinks[0].click();
                await DOMHelpers.randomDelay(2000, 3000);
                transactions = await extractTransactions(page);
            }
        } catch (e) {
            logger.warn(`[bank-extract] Transaction extraction failed: ${e.message}`);
        }

        // Try profile info
        let profile = {};
        try {
            const profileLinks = await page.$$("a[href*='profile'], a[href*='settings'], a:has-text('Profile')");
            if (profileLinks.length > 0) {
                await profileLinks[0].click();
                await DOMHelpers.randomDelay(2000, 3000);
                profile = await extractProfile(page);
            }
        } catch (e) {
            logger.warn(`[bank-extract] Profile extraction failed: ${e.message}`);
        }

        return {
            platform,
            accounts,
            transactions,
            profile,
            extractedAt: new Date().toISOString(),
        };

    } finally {
        await page.close();
        await browser.close();
    }
}

export async function POST(request) {
    try {
        const body = await request.json();
        const { platform, cookies } = body;

        logger.info(`[bank-extract] platform=${platform}`);

        if (!platform || !cookies) {
            return setCorsHeaders(NextResponse.json({ error: "Missing required fields: platform, cookies" }, { status: 400 }));
        }

        const result = await extractBankData(platform.toLowerCase(), cookies);

        return setCorsHeaders(NextResponse.json({
            success: true,
            platform: platform.toLowerCase(),
            data: result,
        }));

    } catch (e) {
        logger.error(`[bank-extract] Error: ${e.message}`);
        return setCorsHeaders(NextResponse.json({ error: e.message }, { status: 500 }));
    }
}

export async function OPTIONS() {
    return new Response(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}
