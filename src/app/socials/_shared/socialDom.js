import logger from "../../../utils/logger.js";
import { DOMHelpers } from "./routeHelper.js";

export function asSelectorList(selector) {
    if (!selector) return [];
    if (Array.isArray(selector)) return selector.filter(Boolean);
    return [selector];
}

export function firstSelector(selectors, keys) {
    for (const key of keys) {
        const value = selectors && selectors[key];
        if (value) return value;
    }
    return null;
}

export async function pause(page, min = 200, max = 600) {
    try {
        await DOMHelpers.randomDelay(min, max);
    } catch (_) {
        await new Promise((r) => setTimeout(r, Math.round((min + max) / 2)));
    }
}

export async function findElement(page, selector, options = {}) {
    const visibleOnly = options.visibleOnly !== false;
    for (const candidate of asSelectorList(selector)) {
        try {
            const handles = await page.$$(candidate);
            for (const handle of handles) {
                if (!visibleOnly) return handle;
                const box = await handle.boundingBox().catch(() => null);
                if (box && box.width >= 1 && box.height >= 1) return handle;
            }
        } catch (_) { /* selector unsupported on this page */ }
    }
    return null;
}

export async function exists(page, selector, options = {}) {
    return !!(await findElement(page, selector, options));
}

export async function readNode(page, selector, options = {}) {
    const visibleOnly = options.visibleOnly !== false;
    const sels = asSelectorList(selector);
    if (!sels.length) return { found: false, count: 0 };
    try {
        return await page.evaluate(({ sels, visibleOnly }) => {
            const visible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) return false;
                const style = window.getComputedStyle(el);
                return style.visibility !== "hidden" && style.display !== "none";
            };
            for (const sel of sels) {
                const nodes = Array.from(document.querySelectorAll(sel));
                const usable = visibleOnly ? nodes.filter(visible) : nodes;
                if (!usable.length) continue;
                const el = usable[0];
                const text = String(el.textContent || el.value || "").replace(/\s+/g, " ").trim();
                return {
                    found: true,
                    count: usable.length,
                    pressed: el.getAttribute("aria-pressed"),
                    label: el.getAttribute("aria-label") || "",
                    title: el.getAttribute("title") || "",
                    text: text.slice(0, 300),
                    className: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || ""),
                    disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
                    tag: el.tagName,
                    selector: sel,
                };
            }
            return { found: false, count: 0 };
        }, { sels, visibleOnly });
    } catch (e) {
        logger.debug(`[socialDom] readNode failed: ${e.message}`);
        return { found: false, count: 0 };
    }
}

export async function clickSelector(page, selector, options = {}) {
    const handle = await findElement(page, selector, options);
    if (handle) {
        try {
            if (options.human !== false && DOMHelpers.humanClick) {
                await DOMHelpers.humanClick(page, selector, { timeout: options.timeout || 5000 });
            } else {
                await handle.click();
            }
            return true;
        } catch (_) { /* fall through to DOM click */ }
        try {
            await handle.evaluate((el) => el.click());
            return true;
        } catch (_) { /* ignore */ }
        try { await handle.dispose?.(); } catch (_) { /* ignore */ }
    }
    const sels = asSelectorList(selector);
    if (!sels.length) return false;
    try {
        return await page.evaluate(({ sels }) => {
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el) { el.click(); return true; }
            }
            return false;
        }, { sels });
    } catch (_) {
        return false;
    }
}

export async function clickByText(page, selector, pattern, options = {}) {
    const sels = asSelectorList(selector);
    if (!sels.length) return false;
    try {
        return await page.evaluate(({ sels, pattern, index }) => {
            const re = new RegExp(pattern, "i");
            for (const sel of sels) {
                const nodes = Array.from(document.querySelectorAll(sel));
                const hits = nodes.filter((el) => {
                    const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
                    const r = el.getBoundingClientRect();
                    return r.width >= 1 && r.height >= 1 && re.test(text);
                });
                const el = hits.indexOf === undefined ? hits[0] : hits[0];
                if (el) { el.click(); return true; }
            }
            return false;
        }, { sels, pattern: pattern.source || String(pattern), index: options.index || 0 });
    } catch (_) {
        return false;
    }
}

export async function fillEditable(page, selector, text, options = {}) {
    const handle = await findElement(page, selector, options);
    if (!handle) return false;
    try {
        await handle.click();
        await page.keyboard.down("Control");
        await page.keyboard.press("A");
        await page.keyboard.up("Control");
        await page.keyboard.press("Backspace");
        await handle.type(String(text), { delay: options.delay || 15 });
        return true;
    } catch (_) { /* fall through */ }
    try {
        const sels = asSelectorList(selector);
        return await page.evaluate(({ sels, text }) => {
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (!el) continue;
                if (el.isContentEditable) {
                    el.focus();
                    el.textContent = text;
                } else {
                    el.focus();
                    el.value = text;
                }
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return true;
            }
            return false;
        }, { sels, text: String(text) });
    } catch (_) {
        return false;
    }
}

export async function pressEnter(page) {
    try { await page.keyboard.press("Enter"); return true; } catch (_) { return false; }
}

export async function pressEscape(page) {
    try { await page.keyboard.press("Escape"); return true; } catch (_) { return false; }
}

export async function verifyComposerCleared(page, selector) {
    const sels = asSelectorList(selector);
    if (!sels.length) return { unverified: true };
    try {
        return await page.evaluate(({ sels }) => {
            for (const sel of sels) {
                const nodes = Array.from(document.querySelectorAll(sel));
                if (!nodes.length) continue;
                const ed = nodes.find((el) => el.isContentEditable) || nodes[0];
                const text = String(ed.textContent || ed.value || "").trim();
                return text ? { verified: false, reason: "composer-not-cleared" } : { verified: true };
            }
            return { unverified: true };
        }, { sels });
    } catch (_) {
        return { unverified: true };
    }
}

export async function textPresent(page, text, selector) {
    const needle = String(text || "").replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
    if (!needle) return false;
    const sels = asSelectorList(selector);
    try {
        return await page.evaluate(({ needle, sels }) => {
            const pool = sels.length
                ? sels.flatMap((sel) => Array.from(document.querySelectorAll(sel)))
                : [document.body];
            return pool.some((el) => String(el.textContent || "").replace(/\s+/g, " ").toLowerCase().includes(needle));
        }, { needle, sels });
    } catch (_) {
        return false;
    }
}

export async function verifyOutgoingMessage(page, text, selector) {
    const sels = asSelectorList(selector);
    if (!sels.length) return { unverified: true };
    const needle = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60).toLowerCase();
    if (!needle) return { unverified: true };
    try {
        return await page.evaluate(({ sels, needle }) => {
            for (const sel of sels) {
                const nodes = Array.from(document.querySelectorAll(sel));
                if (!nodes.length) continue;
                const tail = nodes.slice(-8);
                const hit = tail.some((el) => String(el.textContent || "").replace(/\s+/g, " ").toLowerCase().includes(needle));
                return hit ? { verified: true } : { verified: false, reason: "message-not-found" };
            }
            return { unverified: true };
        }, { sels, needle });
    } catch (_) {
        return { unverified: true };
    }
}

export async function toastMatches(page, pattern) {
    const source = pattern instanceof RegExp ? pattern.source : String(pattern || "");
    if (!source) return false;
    try {
        return await page.evaluate(({ source }) => {
            const re = new RegExp(source, "i");
            const nodes = Array.from(document.querySelectorAll(
                "[role='alert'], [role='status'], [class*='toast' i], [class*='Toast'], [class*='notification' i]"
            ));
            return nodes.some((el) => re.test(String(el.textContent || "").trim()));
        }, { source });
    } catch (_) {
        return false;
    }
}

export async function verifyPressed(page, selector, wantPressed = true) {
    const node = await readNode(page, selector);
    if (!node.found) return { verified: false, reason: "element-missing" };
    if (node.pressed === "true") return wantPressed ? { verified: true } : { verified: false, reason: "already-pressed" };
    if (node.pressed === "false") return wantPressed ? { verified: false, reason: "aria-pressed-false" } : { verified: true };
    return { unverified: true };
}

export async function verifyLabel(page, selector, pattern, options = {}) {
    const node = await readNode(page, selector);
    if (!node.found) return { verified: false, reason: "element-missing" };
    const haystack = `${node.text} ${node.label} ${node.title} ${node.className}`;
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern || ""), "i");
    return re.test(haystack) ? { verified: true } : { verified: false, reason: "label-mismatch" };
}

export async function safeGoto(page, url, options = {}) {
    if (!url) return false;
    try {
        await page.goto(url, { waitUntil: options.waitUntil || "domcontentloaded", timeout: options.timeout || 45000 });
        await pause(page, options.minPause || 1200, options.maxPause || 2600);
        return true;
    } catch (e) {
        logger.warn(`[socialDom] navigation failed for ${url}: ${e.message}`);
        return false;
    }
}

export async function dismissPopups(page, selectors = []) {
    const candidates = [
        ...asSelectorList(selectors),
        "button[aria-label='Close']",
        "[aria-label='Dismiss']",
        "[data-e2e='cookie-banner-close']",
    ];
    for (const selector of candidates) {
        try {
            const hit = await clickSelector(page, selector, { human: false });
            if (hit) await pause(page, 200, 400);
        } catch (_) { /* best effort */ }
    }
    await pressEscape(page);
}

export async function scrollBy(page, distance = 600, selector = null) {
    try {
        if (selector) {
            const handle = await findElement(page, selector);
            if (handle) {
                await handle.evaluate((el, px) => el.scrollBy(0, px), distance);
                return true;
            }
        }
        await page.evaluate((px) => window.scrollBy(0, px), distance);
        return true;
    } catch (_) {
        return false;
    }
}

export async function url(page) {
    try { return String(page.url() || ""); } catch (_) { return ""; }
}

export async function isLoggedOut(page, selectors = []) {
    const current = (await url(page)).toLowerCase();
    if (/\/(login|signin|sign-in|accounts\/login)/.test(current)) return true;
    const sels = asSelectorList(selectors);
    if (!sels.length) return false;
    try {
        return await page.evaluate(({ sels }) => {
            return sels.some((sel) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width >= 1 && r.height >= 1;
            });
        }, { sels });
    } catch (_) {
        return false;
    }
}

export async function collectList(page, itemSelector, fields = {}) {
    const sels = asSelectorList(itemSelector);
    if (!sels.length) return [];
    try {
        return await page.evaluate(({ sels, fields }) => {
            const out = [];
            const seen = new Set();
            for (const sel of sels) {
                const nodes = Array.from(document.querySelectorAll(sel));
                for (const el of nodes) {
                    const r = el.getBoundingClientRect();
                    if (r.width < 1 || r.height < 1) continue;
                    const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
                    if (!text || seen.has(text)) continue;
                    seen.add(text);
                    const row = { text: text.slice(0, 400) };
                    for (const [key, spec] of Object.entries(fields || {})) {
                        if (typeof spec === "string") {
                            const child = el.querySelector(spec);
                            row[key] = child ? String(child.textContent || child.getAttribute("href") || "").trim() : "";
                        } else if (spec && spec.attr) {
                            row[key] = spec.selector
                                ? String((el.querySelector(spec.selector)?.getAttribute(spec.attr)) || "")
                                : String(el.getAttribute(spec.attr) || "");
                        }
                    }
                    out.push(row);
                }
                if (out.length) break;
            }
            return out;
        }, { sels, fields });
    } catch (_) {
        return [];
    }
}

export async function collectLinks(page, selector, filter) {
    const sels = asSelectorList(selector);
    if (!sels.length) return [];
    try {
        const hrefs = await page.evaluate(({ sels }) => {
            const out = [];
            for (const sel of sels) {
                for (const el of Array.from(document.querySelectorAll(sel))) {
                    const href = el.href || el.getAttribute("href") || "";
                    if (href) out.push(href);
                }
                if (out.length) break;
            }
            return out;
        }, { sels });
        const re = filter instanceof RegExp ? filter : null;
        const unique = [];
        for (const href of hrefs) {
            if (re && !re.test(href)) continue;
            if (!unique.includes(href)) unique.push(href);
        }
        return unique;
    } catch (_) {
        return [];
    }
}

export async function probeSelectors(page, selectors) {
    const out = {};
    for (const [key, selector] of Object.entries(selectors || {})) {
        const sels = asSelectorList(selector);
        if (!sels.length) { out[key] = { count: 0, visible: 0 }; continue; }
        try {
            out[key] = await page.evaluate(({ sels }) => {
                let count = 0;
                let visible = 0;
                let sample = "";
                for (const sel of sels) {
                    const nodes = Array.from(document.querySelectorAll(sel));
                    count += nodes.length;
                    for (const el of nodes) {
                        const r = el.getBoundingClientRect();
                        if (r.width >= 1 && r.height >= 1) {
                            visible += 1;
                            if (!sample) sample = String(el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120);
                        }
                    }
                }
                return { count, visible, sample };
            }, { sels });
        } catch (e) {
            out[key] = { count: 0, visible: 0, error: e.message };
        }
    }
    return out;
}
