import tiktok from "./TikTokHelpers.js";
import twitter from "./TwitterHelpers.js";
import facebook from "./FacebookHelpers.js";
import instagram from "./InstagramHelpers.js";
import whatsapp from "./WhatsappHelpers.js";

const ALIASES = {
    x: "twitter",
    twitter: "twitter",
    tiktok: "tiktok",
    facebook: "facebook",
    fb: "facebook",
    instagram: "instagram",
    ig: "instagram",
    whatsapp: "whatsapp",
    wa: "whatsapp",
};

export const platformHelpers = { tiktok, twitter, facebook, instagram, whatsapp };

export function getPlatformHelper(platform) {
    return platformHelpers[ALIASES[String(platform || "").toLowerCase()]] || null;
}
