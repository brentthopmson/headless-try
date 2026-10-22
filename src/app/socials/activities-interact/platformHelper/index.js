import tiktok from "./TikTokHelpers.js";
import twitter from "./TwitterHelpers.js";
import facebook from "./FacebookHelpers.js";
import instagram from "./InstagramHelpers.js";
import youtube from "./YoutubeHelpers.js";

const ALIASES = {
    x: "twitter",
    twitter: "twitter",
    tiktok: "tiktok",
    facebook: "facebook",
    fb: "facebook",
    instagram: "instagram",
    ig: "instagram",
    youtube: "youtube",
    yt: "youtube",
};

export const platformHelpers = { tiktok, twitter, facebook, instagram, youtube };

export function getPlatformHelper(platform) {
    return platformHelpers[ALIASES[String(platform || "").toLowerCase()]] || null;
}
