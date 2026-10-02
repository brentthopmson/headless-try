// Verification-screen matcher shared by checkVerification (routeHelper.js).
// CJS so jest can require() it. The function is passed straight into
// page.evaluate(frame.evaluate) — puppeteer serializes its SOURCE into the
// page, so matchVerificationView must be fully self-contained: no references
// to module-scope symbols, only its own parameters and nested helpers.

/**
 * @param {object} view  one entry from platformConfig.verificationScreens
 *                       ({ match: { selector, text? } }).
 * @param {Document|object} root  a real DOM Document in the browser, or a
 *                       fake root in tests ({ querySelectorAll, body }).
 * @returns {boolean}
 */
function matchVerificationView(view, root) {
    function normalize(s) {
        return String(s == null ? '' : s)
            .replace(/[\u2018\u2019\u201B]/g, "'")   // curly → straight apostrophe
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }
    // Production path: page.evaluate(fn, view) calls fn(view) with NO root —
    // default to the evaluate realm's `document`. Jest passes an explicit fake
    // root instead (global.document is absent there).
    if (!root || typeof root.querySelectorAll !== 'function') {
        root = (typeof document !== 'undefined') ? document : null;
    }
    const match = view && view.match;
    if (!match || !root || typeof root.querySelectorAll !== 'function') return false;
    const selectors = Array.isArray(match.selector) ? match.selector : [match.selector];
    const wanted = match.text ? normalize(match.text) : '';

    for (const sel of selectors) {
        if (typeof sel !== 'string' || !sel) continue;
        let els;
        try { els = root.querySelectorAll(sel); } catch (e) { continue; }
        if (!els || !els.length) continue;
        if (!wanted) return true; // view has no text criterion — any hit matches
        for (let i = 0; i < els.length; i++) {
            if (normalize(els[i] && els[i].textContent).indexOf(wanted) !== -1) return true;
        }
    }

    // Rendered-text fallback: the heading may be a tag we did not enumerate
    // (plain div, custom web-component). innerText skips display:none
    // subtrees, so hidden pre-renders cannot cause a false positive here.
    if (wanted && root.body && typeof root.body.innerText === 'string') {
        if (normalize(root.body.innerText).indexOf(wanted) !== -1) return true;
    }
    return false;
}

module.exports = { matchVerificationView };
