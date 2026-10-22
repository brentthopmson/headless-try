import { emailInboxPlatforms } from "../_shared/platforms.js";

// Inbox read/reply configuration lives with the provider compose config in
// emails/_shared/platforms.js (single provider source).
export const INBOX_CONFIGS = emailInboxPlatforms;

export function detectInboxProvider(email) {
    const domain = String(email || "").split("@")[1]?.toLowerCase() || "";
    if (domain.includes("gmail") || domain.includes("googlemail")) return "gmail";
    if (domain.includes("outlook") || domain.includes("hotmail") || domain.includes("live")) return "outlook";
    if (domain.includes("yahoo")) return "yahoo";
    if (domain.includes("aol")) return "aol";
    return null;
}

export default INBOX_CONFIGS;
