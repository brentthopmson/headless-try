// Contact sanitize + dedupe helpers shared by Gmail/Microsoft extraction.
const CONTACT_JUNK_PHRASES = [
    /send email in new window/gi,
    /copy email address/gi,
    /content_copy/gi,
    /view profile/gi,
    /show profiles?/gi,
    /more actions/gi,
    /manage labels?/gi,
    /create label/gi,
];

function findEmailInText(text) {
    const m = String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    return m ? m[0].toLowerCase() : '';
}

// Strip glued Google UI phrases BEFORE email extraction — otherwise
// "brett@x.comSend email in new window" matches as "brett@x.comsend".
function stripContactJunk(text) {
    let n = String(text || '');
    for (const re of CONTACT_JUNK_PHRASES) n = n.replace(re, ' ');
    return n;
}

function sanitizeContactFields(name, email) {
    // 1) Strip known Google UI button/aria phrases first (they are glued to the email)
    let n = stripContactJunk(String(name || ''));
    let e = stripContactJunk(String(email || '')).trim().toLowerCase();
    // 2) Pull an embedded email out of the name (dirty Gmail rows)
    const embedded = findEmailInText(n);
    if (embedded) {
        if (!e) e = embedded;
        n = n.replace(new RegExp(embedded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
    }
    n = n.replace(/\s+/g, ' ').trim();
    if (e && n.toLowerCase() === e) n = '';
    if (e && !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e)) e = '';
    if (n.length > 120) n = n.slice(0, 120).trim();
    return { name: n, email: e };
}

// Dedup key: normalized email from EITHER field, else name, else phone
// (phone-only rows must survive dedupe instead of being dropped).
function contactDedupKey(name, email, phone) {
    const e = findEmailInText(email) || findEmailInText(stripContactJunk(name));
    if (e) return e;
    const n = stripContactJunk(String(name || '')).replace(/\s+/g, ' ').trim().toLowerCase();
    if (n) return n;
    const p = String(phone || '').replace(/\D/g, '');
    if (p) return `phone:${p}`;
    return '';
}

function sanitizeContactRecord(c) {
    if (!c || typeof c !== 'object') return c;
    const { name, email } = sanitizeContactFields(c.name || '', c.email || '');
    return { ...c, name, email };
}

function contactRichness(c) {
    const other = (c && c.otherData) || {};
    return (c?.name ? 2 : 0)
        + (c?.email ? 2 : 0)
        + (other.phoneNumbers?.length || c?.phone ? 1 : 0)
        + (other.company || c?.company ? 1 : 0)
        + (c?.relationshipSummary ? 1 : 0);
}

// Sanitize + dedupe a contact list, merging fields from the loser into the winner.
function dedupeContacts(list) {
    if (!Array.isArray(list)) return [];
    const byKey = new Map();
    const mergeInto = (winner, loser) => {
        const other = { ...(winner.otherData || {}) };
        if (!other.phoneNumbers?.length && loser.otherData?.phoneNumbers?.length) other.phoneNumbers = loser.otherData.phoneNumbers;
        if (!other.company && loser.otherData?.company) other.company = loser.otherData.company;
        if (!other.notes && loser.otherData?.notes) other.notes = loser.otherData.notes;
        winner.otherData = other;
        if (!winner.name && loser.name) winner.name = loser.name;
        if (!winner.email && loser.email) winner.email = loser.email;
        if (!winner.relationshipSummary && loser.relationshipSummary) winner.relationshipSummary = loser.relationshipSummary;
        if (!winner.lastInteractionDate && loser.lastInteractionDate) winner.lastInteractionDate = loser.lastInteractionDate;
        if ((winner.interactionCount || 0) < (loser.interactionCount || 0)) winner.interactionCount = loser.interactionCount;
        return winner;
    };
    for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const c = sanitizeContactRecord(raw);
        const phone = c.otherData?.phoneNumbers?.[0] || c.phone || c.phoneNumbers?.[0] || '';
        const key = contactDedupKey(c.name, c.email, phone);
        if (!key) continue;
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, c); continue; }
        if (contactRichness(c) > contactRichness(prev)) {
            byKey.set(key, mergeInto(c, prev));
        } else {
            mergeInto(prev, c);
        }
    }
    return Array.from(byKey.values());
}

export {
    CONTACT_JUNK_PHRASES,
    findEmailInText,
    stripContactJunk,
    sanitizeContactFields,
    contactDedupKey,
    sanitizeContactRecord,
    contactRichness,
    dedupeContacts,
};
