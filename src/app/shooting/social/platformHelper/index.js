import tiktok from "./TikTokHelpers.js";
import twitter from "./TwitterHelpers.js";
import facebook from "./FacebookHelpers.js";
import instagram from "./InstagramHelpers.js";
import whatsapp from "./WhatsappHelpers.js";
import discord from "./DiscordHelpers.js";

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
    discord: "discord",
};

export const platformHelpers = { tiktok, twitter, facebook, instagram, whatsapp, discord };

export function getPlatformHelper(platform) {
    return platformHelpers[ALIASES[String(platform || "").toLowerCase()]] || null;
}
